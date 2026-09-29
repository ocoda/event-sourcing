import {
	EventCollection,
	type MigrationCollectionReport,
	type MigrationGappedStream,
	type MigrationOptions,
	type MigrationReport,
	type MigrationStep,
	SnapshotCollection,
} from '@ocoda/event-sourcing';
import { type Connection, type ConnectionConfig, createConnection } from 'mariadb';
import {
	CATALOG_TABLE,
	EVENT_COLUMNS,
	type Queryable,
	SNAPSHOT_COLUMNS,
	assertTableName,
	escapeId,
	inspectEventTable,
	inspectSnapshotTable,
	isMigrationTable,
	latestIndexes,
	snapshotColumnsAreV2,
	tableIndexes,
} from '../mariadb.schema.js';
import {
	type MigrationPlan,
	type PlanOptions,
	type PlannedStep,
	planEventMigration,
	planSnapshotMigration,
} from './plan.js';
import {
	acquireLockSql,
	caseVariantStreamsSql,
	duplicateEventIdsSql,
	gappedStreamsSampleSql,
	gappedStreamsTotalSql,
	lockWaitSecondsOf,
	nonCrockfordEventIdsSql,
	occurredOnRepairSql,
	releaseLockSql,
	sessionSql,
	snapshotFlagsSql,
} from './sql.js';

/**
 * Runs the MariaDB migration from 3.x to schema v2 (ADR 0002 §6): for every table, inspect, plan (plan.ts), then run
 * the planned steps on a connection of its own, under a named lock per table. A dry run inspects and plans only.
 */

export type MigrationKind = 'events' | 'snapshots';

/**
 * @internal For the specs: called after every step the migration ran. A hook that throws stops the migration right
 * there, as a crash would.
 */
export interface MigrationHooks {
	onStepComplete?(collection: string, step: string): void | Promise<void>;
}

/** The store options that are not connection options. */
type StoreOnlyOptions = { driver?: unknown; useDefaultPool?: unknown; ddl?: unknown };

/** The connection options of a store's configuration, without the options of the store itself. */
export const connectionConfigOf = (config: ConnectionConfig & StoreOnlyOptions): ConnectionConfig => {
	const { driver: _driver, useDefaultPool: _useDefaultPool, ddl: _ddl, ...connection } = config;
	return connection;
};

/**
 * Migrates the event or snapshot tables of the database of `config`, on a connection of its own. A migration that
 * fails leaves each table either untouched or in a state that the next run continues from.
 */
export const runMigration = async (
	config: ConnectionConfig & StoreOnlyOptions,
	kind: MigrationKind,
	options: MigrationOptions = {},
	hooks: MigrationHooks = {},
): Promise<MigrationReport> => {
	const connection = await createConnection(connectionConfigOf(config));
	let failed = false;
	try {
		return await migrate(connection, kind, options, hooks);
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		// A failed migration may have left session settings (bulk load) or the named lock behind: drop the connection
		if (failed) {
			connection.destroy();
		} else {
			await connection.end();
		}
	}
};

interface Environment {
	report: MigrationReport['environment'];
	noBackslashEscapes: boolean;
}

const environmentOf = async (db: Queryable): Promise<Environment> => {
	const [row] = await db.query<
		{ version: string; global_tz: string; system_tz: string; session_tz: string; sql_mode: string }[]
	>(
		'SELECT VERSION() AS version, @@global.time_zone AS global_tz, @@system_time_zone AS system_tz, @@session.time_zone AS session_tz, @@sql_mode AS sql_mode',
	);
	const server = row.global_tz === 'SYSTEM' ? `SYSTEM (${row.system_tz})` : row.global_tz;
	return {
		report: {
			serverVersion: row.version,
			timeZones: {
				process: Intl.DateTimeFormat().resolvedOptions().timeZone,
				server,
				session: row.session_tz === 'SYSTEM' ? server : row.session_tz,
			},
		},
		noBackslashEscapes: /NO_BACKSLASH_ESCAPES/i.test(row.sql_mode ?? ''),
	};
};

const migrate = async (
	connection: Connection,
	kind: MigrationKind,
	options: MigrationOptions,
	hooks: MigrationHooks,
): Promise<MigrationReport> => {
	const dryRun = options.dryRun ?? false;
	const environment = await environmentOf(connection);
	const planOptions: PlanOptions = {
		lockWaitSeconds: lockWaitSecondsOf(options.lockTimeoutMs),
		noBackslashEscapes: environment.noBackslashEscapes,
		keepBackup: options.keepBackup ?? true,
		repairOccurredOn: options.repairOccurredOn ?? true,
	};
	const collectionOf = kind === 'events' ? EventCollection.get : SnapshotCollection.get;
	const tables = options.pools
		? [...new Set(options.pools.map((pool) => collectionOf(pool ?? undefined)))]
		: await discoverTables(connection, kind);

	const collections: MigrationCollectionReport[] = [];
	for (const table of tables) {
		const migration = kind === 'events' ? eventTableMigration : snapshotTableMigration;
		collections.push(
			await migrateTable(connection, table, migration, { dryRun, planOptions, options, hooks, environment }),
		);
	}
	return { dryRun, environment: environment.report, collections };
};

/** The event or snapshot tables of the database, by name and columns; the migration's own tables excluded. */
export const discoverTables = async (db: Queryable, kind: MigrationKind): Promise<string[]> => {
	const suffix = kind === 'events' ? '-events' : '-snapshots';
	const required: readonly string[] = kind === 'events' ? EVENT_COLUMNS : SNAPSHOT_COLUMNS;
	const rows = await db.query<{ TABLE_NAME: string; COLUMN_NAME: string }[]>(
		`SELECT c.TABLE_NAME, c.COLUMN_NAME FROM information_schema.COLUMNS c
		 JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
		 WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE'`,
	);
	const columns = new Map<string, Set<string>>();
	for (const { TABLE_NAME, COLUMN_NAME } of rows) {
		const set = columns.get(TABLE_NAME) ?? new Set<string>();
		set.add(COLUMN_NAME.toLowerCase());
		columns.set(TABLE_NAME, set);
	}
	return [...columns]
		.filter(
			([table, set]) =>
				(table === kind || table.endsWith(suffix)) &&
				table !== CATALOG_TABLE &&
				!isMigrationTable(table) &&
				required.every((column) => set.has(column)),
		)
		.map(([table]) => table)
		.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
};

/** Triggers on a table, and foreign keys from or to it. */
export const dependentsOf = async (db: Queryable, table: string): Promise<string[]> => {
	const [triggers, foreignKeys] = await Promise.all([
		db.query<{ TRIGGER_NAME: string }[]>(
			'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = DATABASE() AND BINARY EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME',
			[table],
		),
		db.query<{ CONSTRAINT_NAME: string; TABLE_NAME: string; REFERENCED_TABLE_NAME: string }[]>(
			`SELECT CONSTRAINT_NAME, TABLE_NAME, REFERENCED_TABLE_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
			 WHERE CONSTRAINT_SCHEMA = DATABASE() AND (BINARY TABLE_NAME = ? OR BINARY REFERENCED_TABLE_NAME = ?)
			 ORDER BY CONSTRAINT_NAME`,
			[table, table],
		),
	]);
	return [
		...triggers.map(({ TRIGGER_NAME }) => `trigger ${TRIGGER_NAME}`),
		...foreignKeys.map(
			({ CONSTRAINT_NAME, TABLE_NAME, REFERENCED_TABLE_NAME }) =>
				`foreign key ${CONSTRAINT_NAME} (${TABLE_NAME} -> ${REFERENCED_TABLE_NAME})`,
		),
	];
};

/** What the migration of one kind of table inspects and plans. */
interface TableMigration {
	kind: MigrationKind;
	inspect(db: Queryable, table: string, options: PlanOptions): Promise<InspectedTable>;
}

interface InspectedTable {
	from: MigrationCollectionReport['from'];
	plan: MigrationPlan;
	/** The analysis of the table for the report, run for a table that the plan migrates or resumes. */
	analyze(dryRun: boolean): Promise<Partial<MigrationCollectionReport>>;
	/** What the report says about the result of a step, such as the rows it caught up. */
	describeResult?(step: string, result: unknown): string | undefined;
}

interface MigrateTableContext {
	dryRun: boolean;
	planOptions: PlanOptions;
	options: MigrationOptions;
	hooks: MigrationHooks;
	environment: Environment;
}

const emptyGapped = (): MigrationCollectionReport['gappedStreams'] => ({ total: 0, sample: [] });

const migrateTable = async (
	connection: Connection,
	table: string,
	migration: TableMigration,
	{ dryRun, planOptions, options, hooks }: MigrateTableContext,
): Promise<MigrationCollectionReport> => {
	const base = { name: table, kind: migration.kind, rows: 0, gappedStreams: emptyGapped() };
	try {
		assertTableName(table);
	} catch (error) {
		return {
			...base,
			from: 'absent',
			action: 'blocked',
			steps: [],
			warnings: [],
			blocking: [(error as Error).message],
		};
	}

	const report = (
		inspected: InspectedTable,
		status: MigrationStep['status'],
		analysis: Partial<MigrationCollectionReport> = {},
	): MigrationCollectionReport => ({
		...base,
		...analysis,
		from: inspected.from,
		action: inspected.plan.action,
		steps: inspected.plan.steps.map((step) => ({ ...step, status })),
		warnings: [...inspected.plan.warnings, ...(analysis.warnings ?? [])],
		blocking: inspected.plan.blocking,
	});

	if (dryRun) {
		const inspected = await migration.inspect(connection, table, planOptions);
		const analysis = shouldAnalyze(inspected.plan) ? await inspected.analyze(true) : {};
		return report(inspected, 'pending', analysis);
	}

	await connection.query(sessionSql(planOptions));
	const [{ acquired }] = await connection.query<{ acquired: unknown }[]>(acquireLockSql(table, planOptions));
	if (Number(acquired) !== 1) {
		const inspected = await migration.inspect(connection, table, planOptions);
		return {
			...report(inspected, 'skipped'),
			action: 'blocked',
			blocking: ['Another migration of this table is running (its named lock is taken)'],
		};
	}

	try {
		// Inspected under the lock, so that the plan continues from what earlier runs left behind
		const inspected = await migration.inspect(connection, table, planOptions);
		if (inspected.plan.action === 'blocked' || inspected.plan.action === 'skip') {
			return report(inspected, 'skipped');
		}
		const analysis = await inspected.analyze(false);
		const warnings: string[] = [];
		const steps: MigrationStep[] = [];
		for (const planned of inspected.plan.steps) {
			options.onProgress?.({
				collection: table,
				step: planned.name,
				...(planned.name === 'copy' && analysis.rows !== undefined ? { total: analysis.rows } : {}),
			});
			await runStep(connection, table, planned, inspected, warnings);
			steps.push({ ...planned, status: 'done' });
			await hooks.onStepComplete?.(table, planned.name);
		}
		return {
			...report(inspected, 'done', analysis),
			steps,
			warnings: [...inspected.plan.warnings, ...(analysis.warnings ?? []), ...warnings],
		};
	} finally {
		// Released explicitly when the migration of the table ends; a failure destroys the connection, which releases it
		await connection.query(releaseLockSql(table, planOptions)).catch(() => undefined);
	}
};

const shouldAnalyze = (plan: MigrationPlan): boolean => plan.action === 'migrate' || plan.action === 'resume';

const runStep = async (
	connection: Connection,
	table: string,
	planned: PlannedStep,
	inspected: InspectedTable,
	warnings: string[],
): Promise<void> => {
	// The session and the lock are already in place
	if (planned.name === 'acquire-lock') {
		return;
	}
	let result: unknown;
	try {
		result = await connection.query(planned.statement);
	} catch (error) {
		throw new Error(
			`The migration of ${table} failed at step ${planned.name}: ${(error as Error)?.message ?? String(error)}. Run the migration again: it continues where it stopped.`,
			{ cause: error },
		);
	}
	const note = inspected.describeResult?.(planned.name, result);
	if (note) {
		warnings.push(note);
	}
};

const countOf = async (db: Queryable, sql: string): Promise<number> => {
	const [row] = await db.query<{ total: bigint | number }[]>(sql);
	return Number(row?.total ?? 0);
};

const sizeOf = async (db: Queryable, table: string): Promise<{ rows: number; bytes?: number }> => {
	const [[count], [size]] = await Promise.all([
		db.query<{ total: bigint | number }[]>(`SELECT COUNT(*) AS total FROM ${escapeId(table)}`),
		db.query<{ bytes: bigint | number | null }[]>(
			'SELECT DATA_LENGTH + INDEX_LENGTH AS bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = ?',
			[table],
		),
	]);
	return {
		rows: Number(count?.total ?? 0),
		...(size?.bytes === null || size?.bytes === undefined ? {} : { bytes: Number(size.bytes) }),
	};
};

const gappedStreamsOf = async (db: Queryable, table: string): Promise<MigrationCollectionReport['gappedStreams']> => {
	const [sample, total] = await Promise.all([
		db.query<{ stream_id: string; events: bigint | number; min_version: number; max_version: number }[]>(
			gappedStreamsSampleSql(table),
		),
		countOf(db, gappedStreamsTotalSql(table)),
	]);
	return {
		total,
		sample: sample.map(
			(row): MigrationGappedStream => ({
				streamId: row.stream_id,
				events: Number(row.events),
				minVersion: Number(row.min_version),
				maxVersion: Number(row.max_version),
			}),
		),
	};
};

const eventTableMigration: TableMigration = {
	kind: 'events',
	async inspect(db, table, options) {
		const [inspection, dependents] = await Promise.all([inspectEventTable(db, table), dependentsOf(db, table)]);
		const plan = planEventMigration(
			{
				table,
				state: inspection.state,
				registered: inspection.registered,
				hasColumns: EVENT_COLUMNS.every((column) => inspection.columns.has(column)),
				backup: inspection.backup,
				dependents,
			},
			options,
		);
		return {
			from: inspection.state,
			plan,
			async analyze(dryRun) {
				const size = await sizeOf(db, table);
				if (inspection.state !== 'v1') {
					return { ...size, dependents };
				}
				const [gappedStreams, caseVariantStreams, duplicateEventIds, nonCrockfordEventIds, indexes] = await Promise.all([
					gappedStreamsOf(db, table),
					countOf(db, caseVariantStreamsSql(table)),
					countOf(db, duplicateEventIdsSql(table)),
					countOf(db, nonCrockfordEventIdsSql(table)),
					tableIndexes(db, table),
				]);
				const warnings: string[] = [];
				if (caseVariantStreams > 0) {
					warnings.push(
						`${caseVariantStreams} stream(s) have ids that differ in case only: schema v2 compares stream ids in binary, so they become separate streams (listed as gapped)`,
					);
				}
				if (gappedStreams.total > 0) {
					warnings.push(
						`${gappedStreams.total} stream(s) have gaps in their versions: their next append conflicts; append with the actual version of the stream`,
					);
				}
				const droppedIndexes = indexes.filter(({ name }) => name !== 'PRIMARY').map(({ name }) => name);
				for (const index of indexes) {
					if (index.name !== 'PRIMARY' && index.columns.join(',') !== 'event_date,event_id') {
						warnings.push(`The index ${index.name} (${index.columns.join(', ')}) is not recreated on the migrated table`);
					}
				}
				return {
					...size,
					gappedStreams,
					caseVariantStreams,
					duplicateEventIds,
					nonCrockfordEventIds,
					dependents,
					droppedIndexes,
					// The slowest part of the analysis (about 35 s per million rows): the dry run's
					...(dryRun ? { occurredOnRepair: await occurredOnRepairOf(db, table, options) } : {}),
					warnings,
				};
			},
			describeResult(step, result) {
				const rows = Number((result as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0);
				return step === 'catch-up' && rows > 0
					? `${rows} event(s) written by 3.x during the migration were caught up: stop every 3.x instance before migrating`
					: undefined;
			},
		};
	},
};

const occurredOnRepairOf = async (
	db: Queryable,
	table: string,
	options: PlanOptions,
): Promise<NonNullable<MigrationCollectionReport['occurredOnRepair']>> => {
	const [row] = await db.query<
		{ exact: unknown; precision_only: unknown; tz_shifted: unknown; kept: unknown }[]
	>(occurredOnRepairSql(table));
	const counts = {
		exact: Number(row?.exact ?? 0),
		precisionOnly: Number(row?.precision_only ?? 0),
		tzShifted: Number(row?.tz_shifted ?? 0),
		kept: Number(row?.kept ?? 0),
	};
	return options.repairOccurredOn
		? counts
		: { exact: 0, precisionOnly: 0, tzShifted: 0, kept: counts.exact + counts.precisionOnly + counts.tzShifted + counts.kept };
};

const snapshotTableMigration: TableMigration = {
	kind: 'snapshots',
	async inspect(db, table, options) {
		const [inspection, dependents] = await Promise.all([inspectSnapshotTable(db, table), dependentsOf(db, table)]);
		const nonUnique = latestIndexes(inspection.indexes).filter(({ unique }) => !unique);
		const plan = planSnapshotMigration(
			{
				table,
				state: inspection.state,
				registered: inspection.catalog?.kind === 'snapshots' && inspection.catalog.schemaVersion === 2,
				hasColumns: SNAPSHOT_COLUMNS.every((column) => inspection.columns.has(column)),
				columnsConverted: snapshotColumnsAreV2(inspection.columns),
				latestIndexes: nonUnique.map(({ name }) => name),
				uniqueLatest: latestIndexes(inspection.indexes).some(({ unique }) => unique),
				dependents,
			},
			options,
		);
		return {
			from: inspection.state,
			plan,
			async analyze() {
				const size = await sizeOf(db, table);
				if (!SNAPSHOT_COLUMNS.every((column) => inspection.columns.has(column))) {
					return size;
				}
				const [row] = await db.query<
					{ duplicate_latest: unknown; missing_latest: unknown; misplaced_latest: unknown }[]
				>(snapshotFlagsSql(table));
				const misplaced = Number(row?.misplaced_latest ?? 0);
				const warnings: string[] = [];
				if (misplaced > 0) {
					warnings.push(`${misplaced} stream(s) flag a snapshot other than their highest version: the flag moves to it`);
				}
				if (inspection.columns.get('registered_on')?.extra.includes('on update')) {
					warnings.push(
						'registered_on has the legacy ON UPDATE attribute (servers created before MariaDB 10.10): 3.x may already have overwritten the registered_on of superseded snapshots, which cannot be repaired',
					);
				}
				if (inspection.columns.get('registered_on')?.dataType === 'timestamp') {
					warnings.push(
						"registered_on converts to UTC wall time. Snapshots that a 3.x process wrote in another time zone than the server's are off by that offset; snapshots carry no id with a time to repair it from",
					);
				}
				return {
					...size,
					snapshotFlags: {
						duplicateLatest: Number(row?.duplicate_latest ?? 0),
						missingLatest: Number(row?.missing_latest ?? 0),
					},
					dependents,
					droppedIndexes: nonUnique.map(({ name }) => name),
					warnings,
				};
			},
		};
	},
};
