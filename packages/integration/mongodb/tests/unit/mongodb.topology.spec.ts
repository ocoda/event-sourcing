import type { Logger } from '@nestjs/common';
import type { MongoClient } from 'mongodb';
import { type MigrationContext, readSharded } from '../../lib/migration/inspect.js';
import { capabilitiesOf, detectTopology, warnStandaloneOnce } from '../../lib/mongodb.topology.js';
import { withoutOperationTimeouts } from '../../lib/mongodb.utils.js';

// The topology a store detects and the capabilities it claims for it, without a server: the specs that connect only
// ever see a standalone server and a single-node replica set.

/** A client whose `hello` answers `reply`. */
const clientAnswering = (reply: Record<string, unknown>) => {
	const command = vi.fn(async () => reply);
	const client = { db: vi.fn(() => ({ command })) } as unknown as MongoClient;
	return { client, command };
};

describe('detectTopology', () => {
	it.each([
		['a mongos', { msg: 'isdbgrid', ok: 1 }, 'sharded'],
		['a replica-set member', { setName: 'rs0', isWritablePrimary: true, ok: 1 }, 'replica-set'],
		['a standalone server', { isWritablePrimary: true, ok: 1 }, 'standalone'],
	])('tells %s by its hello reply', async (_, reply, topology) => {
		const { client, command } = clientAnswering(reply);

		await expect(detectTopology(client)).resolves.toBe(topology);
		expect(client.db).toHaveBeenCalledWith('admin');
		expect(command).toHaveBeenCalledWith({ hello: 1 });
	});
});

describe('capabilitiesOf', () => {
	it.each([
		['replica-set', { atomicAppend: true, headers: true, globalOrder: 'gap-safe' }],
		// Transactions, but the visibility of positions across shards is unproven
		['sharded', { atomicAppend: true, headers: true, globalOrder: 'best-effort' }],
		['standalone', { atomicAppend: false, headers: true, globalOrder: 'best-effort' }],
	] as const)('claims for a %s deployment', (topology, capabilities) => {
		expect(capabilitiesOf(topology)).toEqual(capabilities);
	});
});

describe('warnStandaloneOnce', () => {
	it('warns once per process, whatever the number of standalone connections', () => {
		const logger = { warn: vi.fn() } as unknown as Logger;

		warnStandaloneOnce(logger);
		warnStandaloneOnce(logger);
		warnStandaloneOnce({ warn: logger.warn } as unknown as Logger);

		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Run MongoDB as a replica set'));
	});
});

describe('readSharded', () => {
	/** A migration context on a server of the topology, whose `config.collections` lookup does `findOne`. */
	const contextOf = (topology: MigrationContext['topology'], findOne: () => Promise<unknown>) => {
		const collection = vi.fn(() => ({ findOne: vi.fn(findOne) }));
		const client = { db: vi.fn(() => ({ collection })) } as unknown as MongoClient;
		return { client, db: { databaseName: 'es' }, topology, logger: {} } as unknown as MigrationContext;
	};

	it('asks config.collections on a mongos only', async () => {
		const found = vi.fn(async () => ({ _id: 'es.events', key: { _id: 'hashed' } }));
		await expect(readSharded(contextOf('sharded', found), 'events')).resolves.toBe(true);
		await expect(readSharded(contextOf('replica-set', found), 'events')).resolves.toBe(false);
		expect(found).toHaveBeenCalledTimes(1);
	});

	it.each([
		['no entry', null, false],
		['a dropped collection', { _id: 'es.events', dropped: true }, false],
		['an unsplittable collection (8.0)', { _id: 'es.events', unsplittable: true }, false],
	])('reads %s as not sharded', async (_, entry, sharded) => {
		await expect(
			readSharded(
				contextOf('sharded', async () => entry),
				'events',
			),
		).resolves.toBe(sharded);
	});

	it("tells 'unknown' when the user may not read config.collections, and rethrows other errors", async () => {
		const unauthorized = Object.assign(new Error('not authorized on config'), { code: 13 });
		await expect(
			readSharded(
				contextOf('sharded', async () => {
					throw unauthorized;
				}),
				'events',
			),
		).resolves.toBe('unknown');

		const failure = Object.assign(new Error('network'), { code: 6 });
		await expect(
			readSharded(
				contextOf('sharded', async () => {
					throw failure;
				}),
				'events',
			),
		).rejects.toBe(failure);
	});
});

describe('withoutOperationTimeouts', () => {
	it.each([
		['mongodb://h/es', 'mongodb://h/es'],
		['mongodb://h/es?socketTimeoutMS=30000', 'mongodb://h/es'],
		[
			'mongodb://a,b/es?replicaSet=rs0&SocketTimeoutMS=1&timeoutms=2&w=majority',
			'mongodb://a,b/es?replicaSet=rs0&w=majority',
		],
		['mongodb+srv://u:p%3F@h/es?timeoutMS=5&', 'mongodb+srv://u:p%3F@h/es'],
	])('leaves the timeouts of one operation out of %s and the options', (url, expected) => {
		expect(withoutOperationTimeouts({ url, socketTimeoutMS: 30_000, timeoutMS: 10_000, appName: 'app' })).toEqual({
			url: expected,
			socketTimeoutMS: 0,
			appName: 'app',
		});
	});
});
