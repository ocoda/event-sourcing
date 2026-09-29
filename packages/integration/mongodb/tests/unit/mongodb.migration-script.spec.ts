import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { renderMigrationScript } from '../../lib/migration/script.js';

// migrations/4.0.mongosh.js is generated from the planner of migrate(): `pnpm gen:migration-sql` writes it (it runs
// this spec with UPDATE_MIGRATION_SQL=1). A change to the planner that isn't regenerated fails here.
const file = resolve(import.meta.dirname, '../../migrations/4.0.mongosh.js');

/** Formats the script the way `oxfmt --check` of the package expects it. */
const format = (source: string): string => {
	const oxfmt = resolve(dirname(createRequire(import.meta.url).resolve('oxfmt/package.json')), 'bin/oxfmt');
	return execFileSync(process.execPath, [oxfmt, '--stdin-filepath', file], { input: source, encoding: 'utf8' });
};

describe('migrations/4.0.mongosh.js', () => {
	it('is what the migration planner produces for the 3.0.x default collections', () => {
		const expected = format(renderMigrationScript());
		if (process.env.UPDATE_MIGRATION_SQL === '1') {
			writeFileSync(file, expected);
		}

		expect(readFileSync(file, 'utf8'), 'regenerate it with `pnpm gen:migration-sql`').toBe(expected);
	});

	it('fences, numbers by the key the ids allow, registers, then cleans up, events before snapshots', () => {
		const script = renderMigrationScript();
		const at = (text: string) => {
			expect(script).toContain(text);
			return script.indexOf(text);
		};

		expect(at("db.runCommand({ collMod: 'events'")).toBeLessThan(at('if (canonicalIds) {'));
		expect(at('sortBy: { _id: 1 }')).toBeLessThan(at("$concat: ['$eventDate', '#', '$_id']"));
		expect(at('createIndex({ globalPosition: 1 }, { unique: true })')).toBeLessThan(
			at("updateOne({ _id: 'events' }, { $setOnInsert: { kind: 'events' }"),
		);
		expect(at("dropIndex('eventDate_1__id_1')")).toBeLessThan(at("updateOne({ _id: 'snapshots' }"));
		expect(at("dropIndex('aggregateName_1_latest_1')")).toBeGreaterThan(at("name: 'latest_unique'"));
		expect(script).toContain("insertOne({ _id: 'lock:migrate:events', kind: 'lock', owner: owner,");
		expect(script).toContain("deleteOne({ _id: 'lock:migrate:snapshots', owner: owner })");
		expect(script).not.toContain('<owner>');
	});
});
