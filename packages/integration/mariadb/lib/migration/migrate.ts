import {
	EventCollection,
	type MigrationCanonicalizedStream,
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
	type ColumnInfo,
	EVENT_COLUMNS,
	type Queryable,
	SNAPSHOT_COLUMNS,
	assertTableName,
	backupTableName,
	escapeId,
	inspectEventTable,
	inspectSnapshotTable,
	isMigrationTable,
	latestIndexes,
	snapshotColumnsAreV2,
	tableColumns,
	tableIndexes,
} from '../mariadb.schema.js';
import { MariaDBErrorNumber, errorNumberOf, isFatalConnectionError, isGaleraNode } from '../mariadb.utils.js';
import {
	type MigrationPlan,
	type PlanOptions,
	type PlannedStep,
	planEventMigration,
	planSnapshotMigration,
} from './plan.js';
import {
	GALERA_FRAGMENT_BYTES,
	GALERA_MIN_FRAGMENT_BYTES,
	acquireLockSql,
	canonicalizedEventStreamsSql,
	canonicalizedSnapshotStreamsSql,
	caseVariantStreamsSql,
	duplicateEventIdsSql,
	galeraFragmentBytesOf,
	gappedStreamsSampleSql,
	gappedStreamsTotalSql,
	lockWaitSecondsOf,
	nonCrockfordEventIdsSql,
	occurredOnRepairSql,
	otherTransactionsSql,
	releaseLockSql,
	lockNameSql,
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

/**
 * The connection options of the migration: a store's configuration without the options of the store itself, and
 * without a socket timeout. A copy runs for minutes without a byte on the socket, and an application's `socketTimeout`
 * would drop the connection while the server goes on.
 */
export const connectionConfigOf = (config: ConnectionConfig & StoreOnlyOptions): ConnectionConfig => {
	const { driver: _driver, useDefaultPool: _useDefaultPool, ddl: _ddl, ...connection } = config;
	return { ...connection, socketTimeout: 0 };
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
	galera: boolean;
	/** On Galera, the size of the fragments the copy replicates in, for the node's `wsrep_max_ws_size`. */
	galeraFragmentBytes?: number;
}

const environmentOf = async (db: Queryable): Promise<Environment> => {
	const [[row], galera] = await Promise.all([
		db.query<{ version: string; global_tz: string; system_tz: string; session_tz: string; sql_mode: string }[]>(
			'SELECT VERSION() AS version, @@global.time_zone AS global_tz, @@system_time_zone AS system_tz, @@session.time_zone AS session_tz, @@sql_mode AS sql_mode',
		),
		isGaleraNode(db),
	]);
	const server = row.global_tz === 'SYSTEM' ? `SYSTEM (${row.system_tz})` : row.global_tz;
	return {
		report: {
			serverVersion: row.version,
			...(galera ? { topology: 'galera' } : {}),
			timeZones: {
				process: Intl.DateTimeFormat().resolvedOptions().timeZone,
				server,
				session: row.session_tz === 'SYSTEM' ? server : row.session_tz,
			},
		},
		noBackslashEscapes: /NO_BACKSLASH_ESCAPES/i.test(row.sql_mode ?? ''),
		galera,
		...(galera ? { galeraFragmentBytes: galeraFragmentBytesOf(await maxWriteSetBytesOf(db)) } : {}),
	};
};

/** @internal A Galera node's largest write set (`wsrep_max_ws_size`), when the server reports it. */
export const maxWriteSetBytesOf = async (db: Queryable): Promise<number | undefined> => {
	try {
		const [row] = await db.query<{ bytes: bigint | number | string | null }[]>(
			'SELECT @@global.wsrep_max_ws_size AS bytes',
		);
		return row?.bytes === null || row?.bytes === undefined ? undefined : Number(row.bytes);
	} catch {
		return undefined;
	}
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
		galera: environment.galera,
		...(environment.galeraFragmentBytes === undefined ? {} : { galeraFragmentBytes: environment.galeraFragmentBytes }),
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
			`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS
			 WHERE EVENT_OBJECT_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ? AND BINARY EVENT_OBJECT_TABLE = ? ORDER BY TRIGGER_NAME`,
			[table, table],
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
	if (!(await acquireLock(connection, table, planOptions))) {
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

/** Takes the named lock of a table's migration: false when another session holds it. */
const acquireLock = async (connection: Connection, table: string, options: PlanOptions): Promise<boolean> => {
	try {
		const [{ acquired }] = await connection.query<{ acquired: unknown }[]>(acquireLockSql(table, options));
		return Number(acquired) === 1;
	} catch (error) {
		if (errorNumberOf(error) === MariaDBErrorNumber.SubqueryReturnsMoreThanOneRow) {
			return false;
		}
		throw error;
	}
};

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
		// A lock wait timeout leaves the connection usable: name the sessions that may hold the lock
		const sessions =
			errorNumberOf(error) === MariaDBErrorNumber.LockWaitTimeout ? await otherTransactionsOf(connection) : [];
		throw new Error(
			`The migration of ${table} failed at step ${planned.name}: ${(error as Error)?.message ?? String(error)}. ${failureHint(planned.name, error, table, sessions)}`,
			{ cause: error },
		);
	}
	const note = inspected.describeResult?.(planned.name, result);
	if (note) {
		warnings.push(note);
	}
};

/**
 * @internal The other sessions with an open InnoDB transaction, oldest first, as `#<id> <user>@<host>`. Reading them
 * needs the `PROCESS` privilege: without it, none.
 */
export const otherTransactionsOf = async (db: Queryable): Promise<string[]> => {
	try {
		const rows =
			await db.query<{ id: bigint | number; account_user: string | null; account_host: string | null }[]>(
				otherTransactionsSql(),
			);
		return rows.map(({ id, account_user, account_host }) =>
			account_user ? `#${id} ${account_user}@${account_host ?? '?'}` : `#${id}`,
		);
	} catch {
		return [];
	}
};

/**
 * What to do about a failed step. Every step can run again. The copy locks every row of the 3.x table (REPEATABLE
 * READ), which can outgrow the lock memory of a small buffer pool: then the copy can run in READ COMMITTED instead,
 * by hand, and the catch-up after the swap copies the rows 3.x wrote meanwhile. `sessions` are the other sessions with
 * an open transaction, for a lock wait timeout.
 */
export const failureHint = (step: string, error: unknown, table?: string, sessions: readonly string[] = []): string => {
	const rerun = 'Run the migration again: it continues where it stopped.';
	const errno = errorNumberOf(error);
	const message = String((error as { message?: unknown } | null | undefined)?.message ?? '');
	if (step === 'copy' && errno === MariaDBErrorNumber.LockTableFull) {
		return `The copy locks every row of the 3.x table and ran out of lock memory: increase innodb_buffer_pool_size and ${rerun.charAt(0).toLowerCase()}${rerun.slice(1)} Or run the statements of a dry run by hand, with SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED before the copy, while no 3.x instance runs: the catch-up step copies what 3.x wrote during the copy.`;
	}
	if (errno === MariaDBErrorNumber.LockWaitTimeout) {
		const holders =
			sessions.length > 0
				? ` Sessions with an open transaction, oldest first: ${sessions.join(', ')} (KILL <id> ends one).`
				: '';
		return `A session still uses the table (a 3.x instance?): stop it.${holders} ${rerun}`;
	}
	if (
		errno === MariaDBErrorNumber.DiskFull ||
		errno === MariaDBErrorNumber.RecordFileFull ||
		/Temp file write failure|Errcode: 28|No space left/i.test(message)
	) {
		return `The server ran out of disk space: the copy sorts in tmpdir (@@tmpdir), which needs about 1.5 times the event table, and writes a copy of the table to the data directory. Make room, or point tmpdir at a larger volume, then ${rerun.charAt(0).toLowerCase()}${rerun.slice(1)}`;
	}
	if (/writeset size/i.test(message)) {
		return `A write set exceeds Galera's largest one (wsrep_max_ws_size): the migration replicates in fragments of half of wsrep_max_ws_size read when it started (${GALERA_FRAGMENT_BYTES} bytes at most, ${GALERA_MIN_FRAGMENT_BYTES} at least), so it was lowered since, or is below ${2 * GALERA_MIN_FRAGMENT_BYTES} bytes. Raise it, then ${rerun.charAt(0).toLowerCase()}${rerun.slice(1)}`;
	}
	if (
		errno === MariaDBErrorNumber.TableAccessDenied ||
		errno === MariaDBErrorNumber.DatabaseAccessDenied ||
		errno === MariaDBErrorNumber.SpecificAccessDenied
	) {
		return `The migration's user lacks a privilege: it needs SELECT, INSERT, UPDATE, CREATE, ALTER and DROP on the database. Grant them, then ${rerun.charAt(0).toLowerCase()}${rerun.slice(1)}`;
	}
	if (isFatalConnectionError(error)) {
		const lock = table ? `SELECT IS_USED_LOCK(${lockNameSql(table, { noBackslashEscapes: false })})` : 'IS_USED_LOCK()';
		return `The connection was lost, and the server may still be running the step: wait until ${lock} returns NULL, then ${rerun.charAt(0).toLowerCase()}${rerun.slice(1)}`;
	}
	return rerun;
};

const countOf = async (db: Queryable, sql: string): Promise<number> => {
	const [row] = await db.query<{ total: bigint | number }[]>(sql);
	return Number(row?.total ?? 0);
};

const sizeOf = async (db: Queryable, table: string): Promise<{ rows: number; bytes?: number }> => {
	const [[count], [size]] = await Promise.all([
		db.query<{ total: bigint | number }[]>(`SELECT COUNT(*) AS total FROM ${escapeId(table)}`),
		db.query<{ bytes: bigint | number | null }[]>(
			`SELECT DATA_LENGTH + INDEX_LENGTH AS bytes FROM information_schema.TABLES
			 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND BINARY TABLE_NAME = ?`,
			[table, table],
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
		sample: sample.map((row): MigrationGappedStream => ({
			streamId: row.stream_id,
			events: Number(row.events),
			minVersion: Number(row.min_version),
			maxVersion: Number(row.max_version),
		})),
	};
};

/** The largest sample of a report's list. */
const SAMPLE_LIMIT = 1000;

const compareBinary = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * The streams whose rows the migration gives one stream id, from `canonicalizedEventStreamsSql` or
 * `canonicalizedSnapshotStreamsSql` (a row per replaced stream id), in binary order.
 */
export const canonicalizedStreamsOf = async (
	db: Queryable,
	sql: string,
): Promise<NonNullable<MigrationCollectionReport['canonicalizedStreams']>> => {
	const rows = await db.query<{ stream_id: string; variant: string; changed: bigint | number }[]>(sql);
	const streams = new Map<string, MigrationCanonicalizedStream>();
	let changed = 0;
	for (const row of rows) {
		const stream = streams.get(row.stream_id) ?? { streamId: row.stream_id, variants: [], rows: 0 };
		stream.variants.push(row.variant);
		stream.rows += Number(row.changed);
		changed += Number(row.changed);
		streams.set(row.stream_id, stream);
	}
	const sorted = [...streams.values()].sort((a, b) => compareBinary(a.streamId, b.streamId));
	for (const stream of sorted) {
		stream.variants.sort(compareBinary);
	}
	return { total: sorted.length, rows: changed, sample: sorted.slice(0, SAMPLE_LIMIT) };
};

/** A few of the replaced stream ids, for a warning: `old -> new`. */
const examplesOf = ({ sample }: NonNullable<MigrationCollectionReport['canonicalizedStreams']>, count = 3): string => {
	const examples = sample
		.flatMap(({ streamId, variants }) => variants.map((variant) => `${variant} -> ${streamId}`))
		.slice(0, count);
	return examples.join(', ');
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
				const [
					gappedStreams,
					caseVariantStreams,
					canonicalizedStreams,
					duplicateEventIds,
					nonCrockfordEventIds,
					indexes,
				] = await Promise.all([
					gappedStreamsOf(db, table),
					countOf(db, caseVariantStreamsSql(table)),
					canonicalizedStreamsOf(db, canonicalizedEventStreamsSql(table)),
					countOf(db, duplicateEventIdsSql(table)),
					countOf(db, nonCrockfordEventIdsSql(table)),
					tableIndexes(db, table),
				]);
				const warnings: string[] = [];
				if (canonicalizedStreams.total > 0) {
					warnings.push(
						`${canonicalizedStreams.total} stream(s) have rows whose ids differ in case only, one stream in 3.x: schema v2 compares stream ids in binary, so ${canonicalizedStreams.rows} row(s) take the stream id of their stream's lowest version (${examplesOf(canonicalizedStreams)}). Use those stream ids from then on`,
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
						warnings.push(
							`The index ${index.name} (${index.columns.join(', ')}) is not recreated on the migrated table`,
						);
					}
				}
				return {
					...size,
					gappedStreams,
					caseVariantStreams,
					canonicalizedStreams,
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
	const [row] = await db.query<{ exact: unknown; precision_only: unknown; tz_shifted: unknown; kept: unknown }[]>(
		occurredOnRepairSql(table),
	);
	const counts = {
		exact: Number(row?.exact ?? 0),
		precisionOnly: Number(row?.precision_only ?? 0),
		tzShifted: Number(row?.tz_shifted ?? 0),
		kept: Number(row?.kept ?? 0),
	};
	return options.repairOccurredOn
		? counts
		: {
				exact: 0,
				precisionOnly: 0,
				tzShifted: 0,
				kept: counts.exact + counts.precisionOnly + counts.tzShifted + counts.kept,
			};
};

/** The event table of a snapshot table's pool: `events` for `snapshots`, `<pool>-events` for `<pool>-snapshots`. */
export const eventTableOf = (snapshotTable: string): string | undefined => {
	const suffix = `-${SnapshotCollection.get()}`;
	if (snapshotTable === SnapshotCollection.get()) {
		return EventCollection.get();
	}
	return snapshotTable.endsWith(suffix) && snapshotTable.length > suffix.length
		? EventCollection.get(snapshotTable.slice(0, -suffix.length))
		: undefined;
};

/** The pool's 3.x event rows that a snapshot table's canonicalization takes stream ids from, or why there are none. */
interface EventSource {
	events?: string;
	warning?: string;
}

/**
 * The 3.x event rows of a snapshot table's pool: its event table while that has the 3.x schema, otherwise that table's
 * `__es_v1` backup. Their stream ids and aggregate ids must compare like the snapshots' (the same collation, as when
 * 3.x created both tables with the database's default), so that the lookups use their primary key and a snapshot
 * stream matches the event stream that the event migration gives the same id.
 */
const eventSourceOf = async (
	db: Queryable,
	snapshotTable: string,
	snapshotColumns: ReadonlyMap<string, ColumnInfo>,
): Promise<EventSource> => {
	const eventTable = eventTableOf(snapshotTable);
	if (!eventTable) {
		return {};
	}
	const backup = backupTableName(eventTable);
	const [eventColumns, backupColumns] = await Promise.all([tableColumns(db, eventTable), tableColumns(db, backup)]);
	const isV1 = (columns: ReadonlyMap<string, ColumnInfo>) =>
		columns.has('event_date') &&
		!columns.has('global_position') &&
		['stream_id', 'version', 'aggregate_id'].every((column) => columns.has(column));
	const [events, columns] = isV1(eventColumns)
		? [eventTable, eventColumns]
		: isV1(backupColumns)
			? [backup, backupColumns]
			: [undefined, undefined];
	if (!events || !columns) {
		return eventColumns.size > 0
			? {
					warning: `The 3.x events of ${eventTable} are gone (no ${backup}): the snapshot streams take the stream id of their lowest snapshot, which can differ in case from the id of their events. Migrate the snapshots before you drop the events' backup`,
				}
			: {};
	}
	const collation = snapshotColumns.get('stream_id')?.collation;
	const collations = [
		columns.get('stream_id'),
		columns.get('aggregate_id'),
		snapshotColumns.get('aggregate_id'),
		snapshotColumns.get('aggregate_name'),
	].map((column) => column?.collation);
	if (collations.some((other) => other !== collation)) {
		return {
			warning: `The snapshot streams don't take the stream ids of the events in ${events}: its ids compare in ${collations[0]}, the snapshots' in ${collation}. They take the stream id of their lowest snapshot, which can differ in case from the id of their events`,
		};
	}
	return { events };
};

const snapshotTableMigration: TableMigration = {
	kind: 'snapshots',
	async inspect(db, table, options) {
		const [inspection, dependents] = await Promise.all([inspectSnapshotTable(db, table), dependentsOf(db, table)]);
		const nonUnique = latestIndexes(inspection.indexes).filter(({ unique }) => !unique);
		const columnsConverted = snapshotColumnsAreV2(inspection.columns);
		const hasColumns = SNAPSHOT_COLUMNS.every((column) => inspection.columns.has(column));
		// The canonicalization runs while the stream ids still compare in the 3.x collation, before the conversion
		const canonicalize = inspection.state !== 'v2' && hasColumns && !columnsConverted;
		const source = canonicalize ? await eventSourceOf(db, table, inspection.columns) : {};
		const plan = planSnapshotMigration(
			{
				table,
				state: inspection.state,
				registered: inspection.catalog?.kind === 'snapshots' && inspection.catalog.schemaVersion === 2,
				hasColumns,
				columnsConverted,
				latestIndexes: nonUnique.map(({ name }) => name),
				uniqueLatest: latestIndexes(inspection.indexes).some(({ unique }) => unique),
				dependents,
				...(source.events ? { events: source.events } : {}),
			},
			options,
		);
		return {
			from: inspection.state,
			plan,
			async analyze() {
				const size = await sizeOf(db, table);
				if (!hasColumns) {
					return size;
				}
				const [[row], caseVariantStreams, canonicalizedStreams] = await Promise.all([
					db.query<{ duplicate_latest: unknown; missing_latest: unknown; misplaced_latest: unknown }[]>(
						snapshotFlagsSql(table),
					),
					canonicalize ? countOf(db, caseVariantStreamsSql(table)) : undefined,
					canonicalize ? canonicalizedStreamsOf(db, canonicalizedSnapshotStreamsSql(table, source.events)) : undefined,
				]);
				const misplaced = Number(row?.misplaced_latest ?? 0);
				const warnings: string[] = source.warning ? [source.warning] : [];
				if (canonicalizedStreams && canonicalizedStreams.total > 0) {
					warnings.push(
						`${canonicalizedStreams.total} snapshot stream(s) take ${source.events ? `the stream id of their events in ${source.events}, or without events the id of their lowest snapshot` : 'the stream id of their lowest snapshot'}: ${canonicalizedStreams.rows} snapshot(s) get another stream id (${examplesOf(canonicalizedStreams)})`,
					);
				}
				if (misplaced > 0) {
					warnings.push(
						`${misplaced} stream(s) flag a snapshot other than their highest version: the flag moves to it`,
					);
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
					...(caseVariantStreams === undefined ? {} : { caseVariantStreams }),
					...(canonicalizedStreams ? { canonicalizedStreams } : {}),
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
