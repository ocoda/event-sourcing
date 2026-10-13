import type { Logger } from '@nestjs/common';
import type { Document, MongoClient } from 'mongodb';
import { type MigrationContext, readSharded } from '../../lib/migration/inspect.js';
import {
	type MongoDBEngine,
	type MongoDBTopology,
	capabilitiesOf,
	detectEngine,
	detectServer,
	detectTopology,
	warnEngineOnce,
	warnStandaloneOnce,
} from '../../lib/mongodb.topology.js';
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

/**
 * A client whose commands answer from `replies` by command name (`hello`, `buildInfo`, ...); a command without a reply
 * fails like MongoDB fails an unknown one. `hosts` are the hosts of its connection string.
 */
const engineClient = (replies: Record<string, Document>, hosts: string[] = ['localhost'], srvHost?: string) => {
	const command = vi.fn(async (body: Document) => {
		const [name] = Object.keys(body);
		if (!(name in replies)) {
			throw Object.assign(new Error(`no such command: '${name}'`), { code: 59, codeName: 'CommandNotFound' });
		}
		return replies[name];
	});
	const client = {
		db: vi.fn(() => ({ command })),
		options: { hosts: hosts.map((host) => ({ host, port: 27017 })), srvHost },
	} as unknown as MongoClient;
	return { client, command };
};

const mongodbBuildInfo = { version: '8.0.4', gitVersion: 'abc', storageEngines: ['wiredTiger'], ok: 1 };

describe('detectEngine', () => {
	it.each<[string, Record<string, Document>, string[], MongoDBEngine]>([
		['MongoDB, a replica set', { buildInfo: mongodbBuildInfo }, ['db-0.example.net'], 'mongodb'],
		['MongoDB, a replica set named rs0', { buildInfo: mongodbBuildInfo }, ['localhost'], 'mongodb'],
		['MongoDB Atlas', { buildInfo: mongodbBuildInfo }, ['cluster0-shard-00-00.abcde.mongodb.net'], 'mongodb'],
		[
			'FerretDB 2',
			{ buildInfo: { version: '7.0.77', ferretdb: { version: 'v2.7.0' }, ok: 1 } },
			['localhost'],
			'ferretdb',
		],
		['FerretDB 1', { buildInfo: { version: '7.0.42', ferretdbVersion: 'v1.24.2', ok: 1 } }, ['localhost'], 'ferretdb'],
		[
			'Amazon DocumentDB',
			{ buildInfo: { version: '5.0.0', ok: 1 }, getEngineVersion: { engineVersion: '3.0.12345', ok: 1 } },
			['docdb-1.cluster-xyz.us-east-1.docdb.amazonaws.com'],
			'amazon-documentdb',
		],
		[
			'Amazon DocumentDB, behind a host name of its own',
			{ buildInfo: { version: '5.0.0', ok: 1 }, getEngineVersion: { engineVersion: '3.0.12345', ok: 1 } },
			['events.internal.example'],
			'amazon-documentdb',
		],
		[
			'Azure Cosmos DB for MongoDB (RU)',
			{ getLastRequestStatistics: { RequestCharge: 1, ok: 1 } },
			['account.mongo.cosmos.azure.com'],
			'cosmos-db',
		],
		['Azure Cosmos DB for MongoDB, by its host name only', {}, ['account.mongo.cosmos.azure.com'], 'cosmos-db'],
		['Azure DocumentDB (vCore), by its host name only', {}, ['c-x.mongocluster.cosmos.azure.com'], 'documentdb'],
		['Amazon DocumentDB elastic, by its host name only', {}, ['x.docdb-elastic.amazonaws.com'], 'amazon-documentdb'],
	])('tells %s', async (_, replies, hosts, engine) => {
		const setName = engine === 'cosmos-db' ? 'globaldb' : 'rs0';
		const { client } = engineClient(replies, hosts);

		await expect(detectEngine(client, { setName, isWritablePrimary: true, ok: 1 })).resolves.toBe(engine);
	});

	it('tells the DocumentDB gateway by the internal document of its hello reply, which a mongos has not', async () => {
		const { client, command } = engineClient({ buildInfo: mongodbBuildInfo });

		await expect(
			detectEngine(client, { msg: 'isdbgrid', internal: { documentdb_versions: ['0.106-0'] }, ok: 1 }),
		).resolves.toBe('documentdb');
		expect(command).not.toHaveBeenCalled();
		await expect(detectEngine(client, { msg: 'isdbgrid', topologyVersion: {}, ok: 1 })).resolves.toBe('mongodb');
	});

	it("asks the vendors' commands only of a replica set with the vendor's name, and takes an error for no signal", async () => {
		const { client, command } = engineClient({ buildInfo: mongodbBuildInfo });

		await expect(detectEngine(client, { setName: 'events', ok: 1 })).resolves.toBe('mongodb');
		expect(command.mock.calls.map(([body]) => Object.keys(body)[0])).toEqual(['buildInfo']);

		// rs0 and globaldb: MongoDB answers CommandNotFound, and Stable API strict refuses buildInfo
		const strict = engineClient({});
		await expect(detectEngine(strict.client, { setName: 'rs0', ok: 1 })).resolves.toBe('mongodb');
		await expect(detectEngine(strict.client, { setName: 'globaldb', ok: 1 })).resolves.toBe('mongodb');
		expect(strict.command.mock.calls.map(([body]) => Object.keys(body)[0])).toEqual([
			'buildInfo',
			'getEngineVersion',
			'buildInfo',
			'getLastRequestStatistics',
		]);
	});

	it('reads the host of a mongodb+srv:// connection string', async () => {
		const { client } = engineClient({}, [], 'cluster.mongo.cosmos.azure.com');

		await expect(detectEngine(client, { ok: 1 })).resolves.toBe('cosmos-db');
	});
});

describe('detectServer', () => {
	it('tells the topology by hello, and the engine', async () => {
		const { client } = engineClient({ hello: { setName: 'rs0', ok: 1 }, buildInfo: mongodbBuildInfo });
		await expect(detectServer(client)).resolves.toEqual({ topology: 'replica-set', engine: 'mongodb' });

		const ferret = engineClient({ hello: { setName: 'rs0', ok: 1 }, buildInfo: { ferretdb: {}, ok: 1 } });
		await expect(detectServer(ferret.client)).resolves.toEqual({ topology: 'replica-set', engine: 'ferretdb' });
	});
});

describe('capabilitiesOf an engine other than MongoDB', () => {
	it.each<[MongoDBTopology, MongoDBEngine, boolean]>([
		['replica-set', 'documentdb', true],
		['sharded', 'documentdb', true],
		['replica-set', 'amazon-documentdb', true],
		// An elastic cluster: a mongos without transactions
		['sharded', 'amazon-documentdb', false],
		['replica-set', 'ferretdb', false],
		['replica-set', 'cosmos-db', false],
		['standalone', 'ferretdb', false],
	])("claims 'best-effort' for a %s that is %s, atomicAppend %s", (topology, engine, atomicAppend) => {
		expect(capabilitiesOf(topology, engine)).toEqual({ atomicAppend, headers: true, globalOrder: 'best-effort' });
	});
});

describe('detectEngine, what is no signal', () => {
	it.each<[string, Record<string, Document>, Document]>([
		// The Atlas proxy answers some commands it doesn't know with ok: 1: the reply must have the vendor's field
		['getEngineVersion without an engineVersion', { getEngineVersion: { ok: 1 } }, { setName: 'rs0', ok: 1 }],
		[
			'getEngineVersion with another version',
			{ getEngineVersion: { engineVersion: '8.0.4', ok: 1 } },
			{ setName: 'rs0', ok: 1 },
		],
		[
			'getLastRequestStatistics without a charge',
			{ getLastRequestStatistics: { ok: 1 } },
			{ setName: 'globaldb', ok: 1 },
		],
		['a buildInfo with ferretdb: null', { buildInfo: { ferretdb: null, ok: 1 } }, { setName: 'rs0', ok: 1 }],
		['an internal field without isdbgrid', { buildInfo: mongodbBuildInfo }, { setName: 'events', internal: 1, ok: 1 }],
	])('%s', async (_, replies, hello) => {
		const { client } = engineClient(replies);

		await expect(detectEngine(client, hello)).resolves.toBe('mongodb');
	});

	it('bounds every probe with maxTimeMS', async () => {
		const { client, command } = engineClient({ buildInfo: mongodbBuildInfo });

		await detectEngine(client, { setName: 'rs0', ok: 1 });

		expect(command.mock.calls.map(([body]) => body)).toEqual([
			{ buildInfo: 1, maxTimeMS: 5000 },
			{ getEngineVersion: 1, maxTimeMS: 5000 },
		]);
	});

	it.each<[string, string, MongoDBEngine]>([
		['Azure Cosmos DB in China', 'account.mongo.cosmos.azure.cn', 'cosmos-db'],
		['Azure DocumentDB in China', 'c-x.mongocluster.cosmos.azure.cn', 'documentdb'],
		['a Cosmos DB 3.2 account', 'account.documents.azure.com', 'cosmos-db'],
	])('tells %s by its host name', async (_, host, engine) => {
		const { client } = engineClient({}, [host]);

		await expect(detectEngine(client, { ok: 1 })).resolves.toBe(engine);
	});

	it('tells the DocumentDB gateway by its documentdb_versions, also without isdbgrid', async () => {
		const { client } = engineClient({});

		await expect(
			detectEngine(client, { setName: 'rs0', internal: { documentdb_versions: ['0.110-0'] }, ok: 1 }),
		).resolves.toBe('documentdb');
	});
});

describe('warnEngineOnce', () => {
	it('warns once per process and engine, and never for MongoDB', () => {
		const logger = { warn: vi.fn() } as unknown as Logger;

		warnEngineOnce('mongodb', logger);
		warnEngineOnce('cosmos-db', logger);
		warnEngineOnce('cosmos-db', logger);
		warnEngineOnce('ferretdb', logger);

		expect(logger.warn).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenNthCalledWith(1, expect.stringMatching(/Azure Cosmos DB for MongoDB.*'best-effort'/));
		expect(logger.warn).toHaveBeenNthCalledWith(2, expect.stringMatching(/^Connected to FerretDB.*not atomic/));
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
