import type { Queryable } from '../../lib/mariadb.schema.js';
import {
	duplicateKeyOf,
	isGaleraNode,
	isOff,
	isOn,
	isRolledBackByServer,
	systemVariableOf,
	withReadCommitted,
} from '../../lib/mariadb.utils.js';

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
	/** A server that knows the given system variables, and answers 1193 for any other. */
	const withVariables = (variables: Record<string, unknown>) =>
		({
			query: vi.fn(async (sql: string) => {
				const name = /^SELECT @@(\w+) AS value$/.exec(sql)?.[1] ?? '';
				if (!(name in variables)) {
					throw Object.assign(new Error(`Unknown system variable '${name}'`), { errno: 1193 });
				}
				return [{ value: variables[name] }];
			}),
		}) as unknown as Queryable;
	const failing = (error: unknown) =>
		({
			query: vi.fn(async () => {
				throw error;
			}),
		}) as unknown as Queryable;
	const galera = '/usr/lib/galera/libgalera_smm.so';

	it.each([
		{ wsrep: 1, provider: galera, isGalera: true },
		{ wsrep: 1n, provider: galera, isGalera: true },
		{ wsrep: 'ON', provider: galera, isGalera: true },
		{ wsrep: 'on', provider: galera, isGalera: true },
		{ wsrep: 0, provider: galera, isGalera: false },
		{ wsrep: 0n, provider: galera, isGalera: false },
		{ wsrep: 'OFF', provider: galera, isGalera: false },
		{ wsrep: null, provider: galera, isGalera: false },
		// A standalone MariaDB started with wsrep_on=ON and no provider (MariaDB 13.0.2 reads @@wsrep_on = 1)
		{ wsrep: 1, provider: 'none', isGalera: false },
		{ wsrep: 1, provider: ' None ', isGalera: false },
		{ wsrep: 1, provider: '', isGalera: false },
		{ wsrep: 1, provider: null, isGalera: false },
	])('@@wsrep_on = $wsrep, @@wsrep_provider = $provider: $isGalera', async ({ wsrep, provider, isGalera }) => {
		await expect(isGaleraNode(withVariables({ wsrep_on: wsrep, wsrep_provider: provider }))).resolves.toBe(isGalera);
	});

	it("is no Galera node when the server doesn't know the variable (1193), and throws any other error", async () => {
		await expect(isGaleraNode(failing({ errno: 1193 }))).resolves.toBe(false);
		const lost = Object.assign(new Error('connection lost'), { errno: 45009, fatal: true });
		await expect(isGaleraNode(failing(lost))).rejects.toBe(lost);
	});
});

describe('systemVariableOf', () => {
	it('reads @@<name>, is undefined for a variable the server lacks (1193), and throws any other error', async () => {
		const query = vi.fn(async () => [{ value: 'OFF' }]);
		await expect(
			systemVariableOf({ query } as unknown as Queryable, 'group_replication_single_primary_mode'),
		).resolves.toBe('OFF');
		expect(query).toHaveBeenCalledWith('SELECT @@group_replication_single_primary_mode AS value');

		const failing = (error: unknown) =>
			({
				query: vi.fn(async () => {
					throw error;
				}),
			}) as unknown as Queryable;
		await expect(systemVariableOf(failing({ errno: 1193 }), 'wsrep_on')).resolves.toBeUndefined();
		const lost = Object.assign(new Error('connection lost'), { errno: 45009, fatal: true });
		await expect(systemVariableOf(failing(lost), 'wsrep_on')).rejects.toBe(lost);
	});

	it('refuses a name that is not one, before it queries', async () => {
		const query = vi.fn();
		await expect(systemVariableOf({ query } as unknown as Queryable, 'version; DROP TABLE x')).rejects.toThrow(
			/Not a system variable name/,
		);
		expect(query).not.toHaveBeenCalled();
	});
});

describe('isOn and isOff', () => {
	it.each([1, 1n, true, '1', 'ON', 'on'])('%s is on, not off', (value) => {
		expect(isOn(value)).toBe(true);
		expect(isOff(value)).toBe(false);
	});
	it.each([0, 0n, false, '0', 'OFF', 'off'])('%s is off, not on', (value) => {
		expect(isOn(value)).toBe(false);
		expect(isOff(value)).toBe(true);
	});
	it.each([null, undefined, '', 'maybe'])('%s is neither', (value) => {
		expect(isOn(value)).toBe(false);
		expect(isOff(value)).toBe(false);
	});
});

describe('isRolledBackByServer', () => {
	it.each([
		{ errno: 1213, rolledBack: true },
		{ errno: 3101, rolledBack: true },
		{ errno: 3100, rolledBack: false },
		{ errno: 1205, rolledBack: false },
		{ errno: undefined, rolledBack: false },
	])('$errno: $rolledBack', ({ errno, rolledBack }) => {
		expect(isRolledBackByServer({ errno })).toBe(rolledBack);
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
