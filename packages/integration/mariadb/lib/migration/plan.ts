import type { MigrationCollectionReport } from '@ocoda/event-sourcing';
import { backupTableName, type CollectionState } from '../mariadb.schema.js';
import {
	type StatementOptions,
	acquireLockSql,
	addUniqueLatestSql,
	bulkLoadOffSql,
	bulkLoadOnSql,
	catchUpSql,
	convertSnapshotsSql,
	copySql,
	createCatalogSql,
	createCopySql,
	dropBackupSql,
	dropCopySql,
	flagLatestSql,
	registerEventsSql,
	registerSnapshotsSql,
	releaseLockSql,
	sessionSql,
	swapSql,
	unflagSupersededSql,
} from './sql.js';

/**
 * The migration planner: a pure function from what the migration found in a table to the steps it runs (ADR 0002 §6).
 * The executor re-inspects a table once it holds the table's lock and plans again, so every run continues where the
 * previous one stopped: a step whose result already holds isn't planned.
 */

export type EventStepName =
	| 'session'
	| 'create-catalog'
	| 'acquire-lock'
	| 'drop-copy'
	| 'create-copy'
	| 'bulk-load-on'
	| 'copy'
	| 'bulk-load-off'
	| 'swap'
	| 'catch-up'
	| 'register'
	| 'drop-backup'
	| 'release-lock';

export type SnapshotStepName =
	| 'session'
	| 'create-catalog'
	| 'acquire-lock'
	| 'convert'
	| 'unflag-superseded'
	| 'flag-latest'
	| 'add-unique-latest'
	| 'register'
	| 'release-lock';

export interface PlannedStep<TName extends string = string> {
	name: TName;
	statement: string;
	lock: string;
}

export interface MigrationPlan<TName extends string = string> {
	action: MigrationCollectionReport['action'];
	steps: PlannedStep<TName>[];
	warnings: string[];
	blocking: string[];
}

export interface PlanOptions extends StatementOptions {
	keepBackup: boolean;
	repairOccurredOn: boolean;
}

/** What the planner needs to know about an event table. */
export interface EventPlanInput {
	table: string;
	state: CollectionState;
	registered: boolean;
	/** The table has every column of an event table. */
	hasColumns: boolean;
	/** The `<t>__es_v1` backup exists. */
	backup: boolean;
	/** Triggers on the table and foreign keys from or to it: a swap would leave them on the backup. */
	dependents: readonly string[];
}

/** What the planner needs to know about a snapshot table. */
export interface SnapshotPlanInput {
	table: string;
	state: CollectionState;
	/** The catalog has the table with schema version 2. */
	registered: boolean;
	/** The table has every column of a snapshot table. */
	hasColumns: boolean;
	/** The columns already have their v2 types and collation. */
	columnsConverted: boolean;
	/** The non-unique indexes on `(aggregate_name, latest)`, which the unique one replaces. */
	latestIndexes: readonly string[];
	/** A unique index on `(aggregate_name, latest)` exists. */
	uniqueLatest: boolean;
	/** Triggers on the table and foreign keys from or to it. */
	dependents: readonly string[];
}

const LOCKS = {
	none: 'none',
	named: 'named lock (GET_LOCK), one migration per table',
	catalog: 'metadata lock on the catalog',
	copy: 'shared locks on every row of the 3.x table: 3.x writes wait, then fail (1205)',
	swap: 'exclusive metadata locks on both tables, for the rename only',
	backup: 'shared locks on the rows of the backup',
	catalogRow: 'the catalog row of the table',
	exclusiveMetadata: 'exclusive metadata lock on the dropped table',
	shared: 'shared table lock (LOCK=SHARED): reads continue, writes wait',
	rows: 'row locks on the snapshots it changes',
} as const;

const step = <TName extends string>(name: TName, statement: string, lock: string): PlannedStep<TName> => ({
	name,
	statement,
	lock,
});

/** The steps that open and close every migration of a table. */
const opening = <TName extends string>(table: string, options: PlanOptions): PlannedStep<TName>[] => [
	step('session' as TName, sessionSql(options), LOCKS.none),
	step('create-catalog' as TName, createCatalogSql(), LOCKS.catalog),
	step('acquire-lock' as TName, acquireLockSql(table, options), LOCKS.named),
];

const closing = <TName extends string>(table: string, options: PlanOptions): PlannedStep<TName> =>
	step('release-lock' as TName, releaseLockSql(table, options), LOCKS.none);

/**
 * Plans the migration of an event table:
 * - `v1`: copy into the v2 schema, swap, catch up, register (`migrate`);
 * - `v1-partial` after a swap (the backup exists, no catalog row): catch up and register (`resume`);
 * - `v2` without a catalog row: register (`resume`); with one: nothing (`skip`), unless the backup is to be dropped;
 * - `absent`: nothing (`skip`).
 */
export const planEventMigration = (input: EventPlanInput, options: PlanOptions): MigrationPlan<EventStepName> => {
	const { table, state } = input;
	const warnings: string[] = [];
	const blocking: string[] = [];
	const register = step<EventStepName>('register', registerEventsSql(table, options), LOCKS.catalogRow);
	const dropBackup = step<EventStepName>('drop-backup', dropBackupSql(table), LOCKS.exclusiveMetadata);
	const withBackup = (steps: PlannedStep<EventStepName>[]) => {
		if (options.keepBackup) {
			warnings.push(
				`The 3.x table is kept as ${backupTableName(table)}; drop it when satisfied: ${dropBackupSql(table)}`,
			);
			return steps;
		}
		return [...steps, dropBackup];
	};

	if (state === 'absent') {
		return { action: 'skip', steps: [], warnings, blocking };
	}

	if (!input.hasColumns) {
		blocking.push('The table lacks columns of an event table: it is not an event table of this store');
		return { action: 'blocked', steps: [], warnings, blocking };
	}
	if (input.dependents.length > 0 && state !== 'v2') {
		blocking.push(
			`The table has dependents that a swap would leave on the backup: ${input.dependents.join(', ')}. Drop them, migrate, and recreate them on the new table.`,
		);
	}

	if (state === 'v1') {
		if (input.backup) {
			blocking.push(
				`A backup ${backupTableName(table)} already exists from an earlier migration: drop or rename it first (${dropBackupSql(table)})`,
			);
		}
		if (blocking.length > 0) {
			return { action: 'blocked', steps: [], warnings, blocking };
		}
		return {
			action: 'migrate',
			steps: [
				...opening<EventStepName>(table, options),
				step('drop-copy', dropCopySql(table), LOCKS.exclusiveMetadata),
				step('create-copy', createCopySql(table), LOCKS.none),
				step('bulk-load-on', bulkLoadOnSql(), LOCKS.none),
				step('copy', copySql(table, options), LOCKS.copy),
				step('bulk-load-off', bulkLoadOffSql(), LOCKS.none),
				step('swap', swapSql(table), LOCKS.swap),
				step('catch-up', catchUpSql(table, options), LOCKS.backup),
				...withBackup([register]),
				closing<EventStepName>(table, options),
			],
			warnings,
			blocking,
		};
	}

	if (state === 'v1-partial') {
		if (!input.backup) {
			blocking.push(
				'The table has neither the 3.x schema nor schema v2 (it has global_position and event_date, or a nullable global_position), and no backup of a swap: restore it from a backup or fix it by hand',
			);
		}
		if (blocking.length > 0) {
			return { action: 'blocked', steps: [], warnings, blocking };
		}
		return {
			action: 'resume',
			steps: [
				...opening<EventStepName>(table, options),
				step('catch-up', catchUpSql(table, options), LOCKS.backup),
				...withBackup([register]),
				closing<EventStepName>(table, options),
			],
			warnings,
			blocking,
		};
	}

	// v2
	if (!input.registered) {
		return {
			action: 'resume',
			steps: [...opening<EventStepName>(table, options), register, closing<EventStepName>(table, options)],
			warnings,
			blocking,
		};
	}
	if (input.backup && !options.keepBackup) {
		return {
			action: 'resume',
			steps: [...opening<EventStepName>(table, options), dropBackup, closing<EventStepName>(table, options)],
			warnings,
			blocking,
		};
	}
	return { action: 'skip', steps: [], warnings, blocking };
};

/**
 * Plans the migration of a snapshot table, in place: convert the columns, repair the latest flags, add the unique
 * index, register. Each step is planned only while its result doesn't hold yet.
 */
export const planSnapshotMigration = (
	input: SnapshotPlanInput,
	options: PlanOptions,
): MigrationPlan<SnapshotStepName> => {
	const { table, state } = input;
	const warnings: string[] = [];
	const blocking: string[] = [];

	if (state === 'absent') {
		return { action: 'skip', steps: [], warnings, blocking };
	}
	if (state === 'v2' && input.registered) {
		return { action: 'skip', steps: [], warnings, blocking };
	}
	if (!input.hasColumns) {
		blocking.push('The table lacks columns of a snapshot table: it is not a snapshot table of this store');
		return { action: 'blocked', steps: [], warnings, blocking };
	}
	if (input.dependents.length > 0 && state !== 'v2') {
		blocking.push(
			`The table has triggers or foreign keys: ${input.dependents.join(', ')}. Drop them, migrate, and recreate them.`,
		);
		return { action: 'blocked', steps: [], warnings, blocking };
	}

	const steps: PlannedStep<SnapshotStepName>[] = opening<SnapshotStepName>(table, options);
	if (state !== 'v2') {
		if (!input.columnsConverted || input.latestIndexes.length > 0) {
			steps.push(step('convert', convertSnapshotsSql(table, input.latestIndexes), LOCKS.shared));
		}
		steps.push(
			step('unflag-superseded', unflagSupersededSql(table), LOCKS.rows),
			step('flag-latest', flagLatestSql(table), LOCKS.rows),
		);
		if (!input.uniqueLatest) {
			steps.push(step('add-unique-latest', addUniqueLatestSql(table), LOCKS.shared));
		}
	}
	steps.push(
		step('register', registerSnapshotsSql(table, options), LOCKS.catalogRow),
		closing<SnapshotStepName>(table, options),
	);

	return { action: state === 'v1' ? 'migrate' : 'resume', steps, warnings, blocking };
};
