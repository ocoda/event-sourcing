import {
	type Queryable,
	eventSchemaRemedy,
	eventTableDdl,
	jsonColumnTypeOf,
	registerEventTable,
	snapshotSchemaRemedy,
	snapshotTableDdl,
	tableIndexes,
} from '../../lib/mariadb.schema.js';

/** A Queryable that answers every query with the next of `answers`, and records what it was asked. */
const recording = (...answers: unknown[]) => {
	const calls: { sql: string; values: unknown }[] = [];
	const db = {
		query: vi.fn(async (sql: string, values?: unknown) => {
			calls.push({ sql, values });
			return answers.shift() ?? [];
		}),
	} as unknown as Queryable;
	return { db, calls };
};

describe(registerEventTable, () => {
	it('binds the highest position twice instead of VALUES(), which MySQL deprecates, and compares it as a number', async () => {
		const { db, calls } = recording([{ last: '9' }]);

		await registerEventTable(db, 'events');

		const upsert = calls[1];
		expect(upsert.sql).not.toContain('VALUES(');
		expect(upsert.sql).toContain('GREATEST(last_position, CAST(? AS SIGNED))');
		expect(upsert.values).toEqual(['events', '9', '9']);
	});
});

describe(tableIndexes, () => {
	it('names the columns of an index, and an expression (a NULL COLUMN_NAME, a MySQL functional key part)', async () => {
		const { db, calls } = recording([
			{ INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0n, COLUMN_NAME: 'Stream_Id' },
			{ INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0n, COLUMN_NAME: 'version' },
			{ INDEX_NAME: 'ix_lower', NON_UNIQUE: 1, COLUMN_NAME: null },
		]);

		await expect(tableIndexes(db, 'events')).resolves.toEqual([
			{ name: 'PRIMARY', unique: true, columns: ['stream_id', 'version'] },
			{ name: 'ix_lower', unique: false, columns: ['(expression)'] },
		]);
		// CAST(… AS BINARY) rather than the BINARY operator, which MySQL deprecates
		expect(calls[0].sql).toContain('CAST(TABLE_NAME AS BINARY) = ?');
		expect(calls[0].sql).not.toMatch(/AND BINARY /);
	});
});

describe('the JSON columns', () => {
	it("are MariaDB's JSON, and LONGTEXT on MySQL, whose JSON type changes doubles and the order of keys", () => {
		expect(jsonColumnTypeOf()).toBe('JSON');
		expect(jsonColumnTypeOf('mariadb')).toBe('JSON');
		expect(jsonColumnTypeOf('mysql')).toBe('LONGTEXT');

		expect(eventTableDdl('events')).toMatch(/payload JSON NOT NULL[\s\S]*headers JSON NULL/);
		expect(eventTableDdl('events', { flavour: 'mysql' })).toMatch(
			/payload LONGTEXT NOT NULL[\s\S]*headers LONGTEXT NULL/,
		);
		expect(eventTableDdl('events', { flavour: 'mysql', ifNotExists: false })).toMatch(/^CREATE TABLE `events`/);
		expect(snapshotTableDdl('snapshots')).toContain('payload JSON NOT NULL');
		expect(snapshotTableDdl('snapshots', { flavour: 'mysql' })).toContain('payload LONGTEXT NOT NULL');
		expect(eventSchemaRemedy('events', 'mysql')).toContain('payload LONGTEXT NOT NULL');
		expect(snapshotSchemaRemedy('snapshots', 'mysql')).toContain('payload LONGTEXT NOT NULL');
	});
});
