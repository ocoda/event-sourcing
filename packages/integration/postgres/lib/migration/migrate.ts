import type { LoggerService } from '@nestjs/common';
import {
	EventCollection,
	type MigrationOptions,
	type MigrationReport,
	SnapshotCollection,
} from '@ocoda/event-sourcing';
import { DatabaseError, type Pool, type PoolClient } from 'pg';
import { LOCK_NOT_AVAILABLE, hasErrorCode } from '../postgres.helpers.js';
import { describeTable, eventTableState, snapshotTableState } from '../postgres.schema.js';
import { type CollectionKind, discoverCollections, inspectCollection } from './inspect.js';
import {
	type CollectionPlan,
	type PlanSettings,
	migrationLockKey,
	planEventMigration,
	planSnapshotMigration,
} from './plan.js';

/**
 * Test hooks of a migration run. Internal: not exported from the package.
 */
export interface MigrationHooks {
	/**
	 * Called after every step that ran. A hook that throws stops the migration there, like a crash: the crash-injection
	 * specs throw after each step in turn and check that a second run ends in the same state as a clean one.
	 */
	onStepComplete?: (collection: string, step: string) => void | Promise<void>;
}

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

/**
 * Runs `migrate()` for the event or snapshot tables of the current schema: for each table, inspects it, plans the steps
 * and (unless it's a dry run) runs them, on one dedicated connection. A table whose migration is blocked is reported
 * and left as it is; an error in a step rolls its transaction back and is thrown.
 */
export const runMigration = async (
	pool: Pool,
	kind: CollectionKind,
	options: MigrationOptions = {},
	logger?: Pick<LoggerService, 'log' | 'warn'>,
	hooks: MigrationHooks = {},
): Promise<MigrationReport> => {
	const dryRun = options.dryRun ?? false;
	const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
		throw new RangeError(`lockTimeoutMs must be a positive integer, got ${String(options.lockTimeoutMs)}`);
	}
	const processTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const legacyTimeZone = options.legacyTimeZone ?? processTimeZone;

	const client = await pool.connect();
	let broken: Error | undefined;
	const onError = (error: Error) => {
		broken ??= error;
	};
	client.on('error', onError);

	try {
		const {
			rows: [environment],
		} = await client.query<{ server_version: string; session: string; server: string | null; zone_known: boolean }>(
			`SELECT current_setting('server_version') AS server_version, current_setting('TimeZone') AS session,
				(SELECT reset_val FROM pg_settings WHERE name = 'TimeZone') AS server,
				EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1) AS zone_known`,
			[legacyTimeZone],
		);
		if (kind === 'snapshots' && !environment.zone_known) {
			throw new RangeError(
				`legacyTimeZone ${JSON.stringify(legacyTimeZone)} is not a time zone the server knows (pg_timezone_names)`,
			);
		}

		const settings: PlanSettings = { lockTimeoutMs, legacyTimeZone };
		const names = options.pools
			? [
					...new Set(
						options.pools.map((pool) =>
							kind === 'events' ? EventCollection.get(pool ?? undefined) : SnapshotCollection.get(pool ?? undefined),
						),
					),
				]
			: await discoverCollections(client, kind);

		const collections: CollectionPlan[] = [];
		for (const name of names) {
			const inspection = await inspectCollection(client, kind, name);
			const plan =
				kind === 'events' ? planEventMigration(inspection, settings) : planSnapshotMigration(inspection, settings);
			collections.push(plan);

			if (dryRun) {
				continue;
			}
			if (plan.action === 'migrate' || plan.action === 'resume') {
				logger?.log(`Migrating ${name} (${plan.from}, ${plan.rows} rows)`);
				await execute(client, plan, options, hooks);
				logger?.log(
					`${name}: ${plan.steps.every(({ status }) => status !== 'pending') && plan.blocking.length === 0 ? 'migrated' : 'not migrated'}`,
				);
			} else {
				for (const step of plan.steps) {
					step.status = 'skipped';
				}
				if (plan.action === 'blocked') {
					logger?.warn(`Not migrating ${name}: ${plan.blocking.join(' ')}`);
				}
			}
		}

		return {
			dryRun,
			environment: {
				serverVersion: environment.server_version,
				timeZones: {
					process: processTimeZone,
					...(environment.server ? { server: environment.server } : {}),
					session: environment.session,
				},
			},
			collections,
		};
	} catch (error) {
		if (!(error instanceof DatabaseError) && !(error instanceof RangeError) && !(error instanceof MigrationStopped)) {
			broken ??= error instanceof Error ? error : new Error(String(error));
		}
		throw error instanceof MigrationStopped ? error.cause : error;
	} finally {
		client.removeListener('error', onError);
		client.release(broken);
	}
};

/**
 * Wraps what a hook threw, so that the connection is not taken for broken.
 */
class MigrationStopped extends Error {}

/**
 * Runs the steps of a plan, and marks each one done. Stops at a blocked lock (the plan becomes `blocked`), and rolls
 * back and rethrows on any error inside the transaction.
 */
const execute = async (
	client: PoolClient,
	plan: CollectionPlan,
	options: MigrationOptions,
	hooks: MigrationHooks,
): Promise<void> => {
	const block = (reason: string) => {
		plan.action = 'blocked';
		plan.blocking.push(reason);
		for (const step of plan.steps) {
			if (step.status === 'pending') {
				step.status = 'skipped';
			}
		}
	};

	let locked = false;
	let inTransaction = false;
	try {
		for (const step of plan.steps) {
			options.onProgress?.({
				collection: plan.name,
				step: step.name,
				...(step.name === 'reinsert' ? { total: plan.rows } : {}),
			});

			switch (step.name) {
				case 'migration-lock': {
					const { rows } = await client.query<{ locked: boolean }>(step.statement);
					if (!rows[0].locked) {
						block('Another migration of this table is running.');
						return;
					}
					locked = true;
					break;
				}
				case 'begin':
					await client.query(step.statement);
					inTransaction = true;
					break;
				case 'lock': {
					try {
						await client.query(step.statement);
					} catch (error) {
						if (!hasErrorCode(error, LOCK_NOT_AVAILABLE)) {
							throw error;
						}
						await client.query('ROLLBACK');
						inTransaction = false;
						block(
							'Other sessions still use the table (is a 3.x instance still running?): the lock was not granted within lockTimeoutMs.',
						);
						return;
					}
					// The table may have changed between the inspection and the lock
					const table = await describeTable(client, plan.name);
					const state = plan.kind === 'events' ? eventTableState(table) : snapshotTableState(table);
					if (state !== plan.from) {
						await client.query('ROLLBACK');
						inTransaction = false;
						block(
							`The table changed from ${plan.from} to ${state} while the migration waited for it: run migrate() again.`,
						);
						return;
					}
					break;
				}
				case 'commit':
					await client.query(step.statement);
					inTransaction = false;
					break;
				case 'vacuum':
					// The migration committed: a failing VACUUM leaves nothing to undo
					try {
						await client.query(step.statement);
					} catch (error) {
						step.status = 'skipped';
						plan.warnings.push(
							`VACUUM failed after the migration committed (${error instanceof Error ? error.message : String(error)}): run it by hand: ${step.statement};`,
						);
						continue;
					}
					break;
				default:
					await client.query(step.statement);
			}

			step.status = 'done';
			try {
				await hooks.onStepComplete?.(plan.name, step.name);
			} catch (error) {
				throw new MigrationStopped('stopped by a hook', { cause: error });
			}
		}
	} catch (error) {
		if (inTransaction) {
			await client.query('ROLLBACK').catch(() => undefined);
		}
		throw error;
	} finally {
		if (locked) {
			await client.query(`SELECT pg_advisory_unlock(${migrationLockKey(plan.name)})`).catch(() => undefined);
		}
	}
};
