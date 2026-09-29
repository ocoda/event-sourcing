import type { Queryable } from '../../lib/mariadb.schema.js';
import { duplicateKeyOf, isGaleraNode, withReadCommitted } from '../../lib/mariadb.utils.js';

describe('duplicateKeyOf', () => {
	it.each([
		{ message: "Duplicate entry 'account-1-1' for key 'PRIMARY'", key: 'PRIMARY' },
		{ message: "Duplicate entry '7' for key 'ux_global_position'", key: 'ux_global_position' },
		{ message: "Duplicate entry 'account-1-1' for key 'events.PRIMARY'", key: 'PRIMARY' },
		// The value is not escaped: a stream id can hold what looks like a key
		{
			message: "Duplicate entry 'account-acc' for key 'ux_global_position-1' for key 'PRIMARY'",
			key: 'PRIMARY',
		},
		{ message: "Duplicate entry 'a\nb' for key 'ux_global_position-1' for key 'PRIMARY'", key: 'PRIMARY' },
		{ message: 'Lock wait timeout exceeded', key: undefined },
	])('names $key in "$message"', ({ message, key }) => {
		expect(duplicateKeyOf({ errno: 1062, sqlMessage: message })).toBe(key);
	});

	it("reads the first line of the connector's message when there is no sqlMessage", () => {
		expect(
			duplicateKeyOf(
				new Error(
					"(conn:12, no: 1062, SQLState: 23000) Duplicate entry 'x-1' for key 'PRIMARY'\nsql: INSERT INTO t VALUES (?) - parameters:['for key 'ux_global_position'']",
				),
			),
		).toBe('PRIMARY');
		expect(duplicateKeyOf(undefined)).toBeUndefined();
	});
});

describe('isGaleraNode', () => {
	const answering = (value: unknown) => ({ query: vi.fn(async () => [{ wsrep: value }]) }) as unknown as Queryable;
	const failing = (error: unknown) =>
		({
			query: vi.fn(async () => {
				throw error;
			}),
		}) as unknown as Queryable;

	it.each([
		{ wsrep: 1, galera: true },
		{ wsrep: 1n, galera: true },
		{ wsrep: 'ON', galera: true },
		{ wsrep: 'on', galera: true },
		{ wsrep: 0, galera: false },
		{ wsrep: 0n, galera: false },
		{ wsrep: 'OFF', galera: false },
		{ wsrep: null, galera: false },
	])('@@wsrep_on = $wsrep: $galera', async ({ wsrep, galera }) => {
		await expect(isGaleraNode(answering(wsrep))).resolves.toBe(galera);
	});

	it("is no Galera node when the server doesn't know the variable (1193), and throws any other error", async () => {
		await expect(isGaleraNode(failing({ errno: 1193 }))).resolves.toBe(false);
		const lost = Object.assign(new Error('connection lost'), { errno: 45009, fatal: true });
		await expect(isGaleraNode(failing(lost))).rejects.toBe(lost);
	});
});

describe('withReadCommitted', () => {
	it("appends READ COMMITTED for the session to the pool's initSql", () => {
		const readCommitted = 'SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED';
		expect(withReadCommitted({ host: 'db' })).toEqual({ host: 'db', initSql: [readCommitted] });
		expect(withReadCommitted({ initSql: 'SET SESSION a = 1' }).initSql).toEqual(['SET SESSION a = 1', readCommitted]);
		expect(withReadCommitted({ initSql: ['SET SESSION a = 1', 'SET SESSION b = 2'] }).initSql).toEqual([
			'SET SESSION a = 1',
			'SET SESSION b = 2',
			readCommitted,
		]);
	});
});
