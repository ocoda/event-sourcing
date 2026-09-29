import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MariaDBEventStore, MariaDBSnapshotStore } from '@ocoda/event-sourcing-mariadb';
import { mariadbRootConfig } from '@ocoda/event-sourcing-testing/unit';
import { type Connection, createConnection } from 'mariadb';
import { renderMigrationSql } from '../../lib/migration/render.js';
import {
	LEGACY_TIMESTAMP_SESSION,
	escapeId,
	insertV1Events,
	insertV1Snapshots,
	v1EventTableDdl,
	v1SnapshotTableDdl,
} from '../fixtures/schema-v1.js';
import { v1Events, v1Snapshots } from '../fixtures/v1-corpus.js';
import { createTestDatabase } from '../support/stores.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// migrations/4.0.sql is generated from the planner of migrate(): `pnpm gen:migration-sql` writes it (it runs this spec
// with UPDATE_MIGRATION_SQL=1). A change to the planner or the statements that isn't regenerated fails here.
const file = resolve(import.meta.dirname, '../../migrations/4.0.sql');

describe('migrations/4.0.sql', () => {
	it('is what the migration planner produces for the 3.x default tables', () => {
		const expected = renderMigrationSql();
		if (process.env.UPDATE_MIGRATION_SQL === '1') {
			writeFileSync(file, expected);
		}

		expect(readFileSync(file, 'utf8'), 'regenerate it with `pnpm gen:migration-sql`').toBe(expected);
	});

	it('copies, swaps and registers the events, and converts the snapshots in place', () => {
		const sql = renderMigrationSql();

		expect(sql.match(/CREATE TABLE IF NOT EXISTS `event_sourcing_collections`/g)).toHaveLength(2);
		expect(sql.match(/tx_isolation = 'REPEATABLE-READ'/g)).toHaveLength(2);
		expect(sql).toContain('CREATE TABLE `events__es_v2`');
		expect(sql).toContain('SET SESSION unique_checks = 0, foreign_key_checks = 0');
		expect(sql).toContain('RENAME TABLE `events` TO `events__es_v1`, `events__es_v2` TO `events`');
		expect(sql).toContain('CONVERT(o.stream_id USING utf8mb4) COLLATE utf8mb4_bin');
		expect(sql).toContain("SHA1(CONCAT(DATABASE(), '.', 'events'))");
		expect(sql).toContain('-- DROP TABLE IF EXISTS `events__es_v1`;');
		expect(sql).toContain('DROP INDEX `idx_aggregate_name_latest`');
		expect(sql).toContain('ADD UNIQUE KEY ux_latest (aggregate_name, latest)');
		expect(
			sql.match(/^SELECT IF\(GET_LOCK\(.*, 0\) = 1, 1, \(SELECT 1 UNION SELECT 2\)\) AS acquired;$/gm),
		).toHaveLength(2);
		expect(sql.match(/^SELECT RELEASE_LOCK/gm)).toHaveLength(2);
	});

	describe('run as a file', () => {
		/** A database with the 3.x tables of the default pools, and a root connection to it that runs whole files. */
		const seeded = async (label: string) => {
			const database = await createTestDatabase(label);
			const root = await createConnection({
				...mariadbRootConfig(),
				database: database.name,
				multipleStatements: true,
			});
			await root.query("SET SESSION time_zone = '+00:00'");
			await root.query(LEGACY_TIMESTAMP_SESSION);
			await root.query(v1EventTableDdl('events'));
			await root.query(v1SnapshotTableDdl('snapshots'));
			await root.query('SET SESSION explicit_defaults_for_timestamp = ON');
			await insertV1Events(root, 'events', v1Events());
			await insertV1Snapshots(root, 'snapshots', v1Snapshots());
			return { database, root };
		};

		const dump = async (root: Connection) => {
			const columns: Record<string, string> = {
				events:
					'stream_id, version, event_id, CAST(occurred_on AS CHAR) AS occurred_on, CAST(global_position AS CHAR) AS global_position',
				events__es_v1: 'stream_id, version, CAST(occurred_on AS CHAR) AS occurred_on',
				snapshots: 'stream_id, version, CAST(registered_on AS CHAR) AS registered_on, latest',
				event_sourcing_collections: 'name, kind, schema_version, CAST(last_position AS CHAR) AS last_position',
			};
			const tables: Record<string, unknown> = {};
			for (const [table, select] of Object.entries(columns)) {
				const [{ 'Create Table': ddl }] = await root.query<{ 'Create Table': string }[]>(
					`SHOW CREATE TABLE ${escapeId(table)}`,
				);
				tables[table] = { ddl, rows: await root.query(`SELECT ${select} FROM ${escapeId(table)} ORDER BY 1, 2`) };
			}
			return tables;
		};

		it('gives what migrate() gives', async () => {
			const [byFile, byMigrate] = [await seeded('sqlfile'), await seeded('sqlrun')];
			try {
				await byFile.root.query(readFileSync(file, 'utf8'));
				await MariaDBEventStore.migrate({ ...byMigrate.database.config });
				await MariaDBSnapshotStore.migrate({ ...byMigrate.database.config });

				expect(await dump(byFile.root)).toEqual(await dump(byMigrate.root));
			} finally {
				for (const { root, database } of [byFile, byMigrate]) {
					await root.end();
					await database.drop();
				}
			}
		});

		it('stops at the lock while another migration of the table holds it', async () => {
			const { database, root } = await seeded('sqllock');
			const holder = await createConnection({ ...mariadbRootConfig(), database: database.name });
			try {
				await holder.query("DO GET_LOCK(CONCAT('ocoda:migrate:', SHA1(CONCAT(DATABASE(), '.', 'events'))), 0)");
				const tables = async () =>
					(await root.query<Record<string, string>[]>('SHOW TABLES')).map((row) => Object.values(row)[0]).sort();
				const before = await tables();

				await expect(root.query(readFileSync(file, 'utf8'))).rejects.toMatchObject({ errno: 1242 });
				// Nothing after the lock ran: the catalog is the only new table
				expect(await tables()).toEqual([...before, 'event_sourcing_collections'].sort());
			} finally {
				await holder.end();
				await root.end();
				await database.drop();
			}
		});
	});
});
