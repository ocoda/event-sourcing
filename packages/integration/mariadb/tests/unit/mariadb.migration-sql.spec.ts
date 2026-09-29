import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderMigrationSql } from '../../lib/migration/render.js';

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
		expect(sql).toContain('CREATE TABLE `events__es_v2`');
		expect(sql).toContain('SET SESSION unique_checks = 0, foreign_key_checks = 0');
		expect(sql).toContain('RENAME TABLE `events` TO `events__es_v1`, `events__es_v2` TO `events`');
		expect(sql).toContain('CONVERT(o.stream_id USING utf8mb4) COLLATE utf8mb4_bin');
		expect(sql).toContain("SHA1(CONCAT(DATABASE(), '.', 'events'))");
		expect(sql).toContain('-- DROP TABLE IF EXISTS `events__es_v1`;');
		expect(sql).toContain('DROP INDEX `idx_aggregate_name_latest`');
		expect(sql).toContain('ADD UNIQUE KEY ux_latest (aggregate_name, latest)');
		expect(sql.match(/^SELECT GET_LOCK/gm)).toHaveLength(2);
		expect(sql.match(/^SELECT RELEASE_LOCK/gm)).toHaveLength(2);
	});
});
