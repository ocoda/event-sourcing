import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderMigrationSql } from '../../lib/migration/sql.js';

// migrations/4.0.sql is generated from the planner of migrate(): `pnpm gen:migration-sql` writes it (it runs this spec
// with UPDATE_MIGRATION_SQL=1). A change to the planner that isn't regenerated fails here.
const file = resolve(import.meta.dirname, '../../migrations/4.0.sql');

describe('migrations/4.0.sql', () => {
	it('is what the migration planner produces for the 3.0.2 default tables', () => {
		const expected = renderMigrationSql();
		if (process.env.UPDATE_MIGRATION_SQL === '1') {
			writeFileSync(file, expected);
		}

		expect(readFileSync(file, 'utf8'), 'regenerate it with `pnpm gen:migration-sql`').toBe(expected);
	});

	it('migrates both default tables in their own transactions, and reads registered_on in a psql variable', () => {
		const sql = renderMigrationSql();

		expect(sql.match(/^BEGIN ISOLATION LEVEL READ COMMITTED/gm)).toHaveLength(2);
		expect(sql.match(/^COMMIT;$/gm)).toHaveLength(2);
		expect(sql).toContain('LOCK TABLE "events" IN ACCESS EXCLUSIVE MODE');
		expect(sql).toContain('LOCK TABLE "snapshots" IN ACCESS EXCLUSIVE MODE');
		expect(sql).toContain("USING registered_on AT TIME ZONE :'legacy_time_zone'");
		expect(sql).toContain('DROP INDEX "idx_snapshots_aggregate_name_latest"');
		expect(sql).not.toContain('pg_try_advisory_lock');
		expect(sql.match(/CREATE TABLE IF NOT EXISTS event_sourcing_collections/g)).toHaveLength(1);
	});
});
