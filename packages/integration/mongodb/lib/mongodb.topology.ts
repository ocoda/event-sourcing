import type { Logger } from '@nestjs/common';
import type { EventStoreCapabilities } from '@ocoda/event-sourcing';
import type { Db, Document, MongoClient } from 'mongodb';

/**
 * The kind of deployment a store is connected to.
 * - `'replica-set'`: transactions, so appends are atomic and the global order is gap-safe (also a single-node replica
 *   set);
 * - `'sharded'`: a `mongos`; transactions, but the visibility of positions across shards is unproven;
 * - `'standalone'`: no transactions.
 */
export type MongoDBTopology = 'standalone' | 'replica-set' | 'sharded';

/**
 * Asks the server what it is (`hello`). The store chooses its append path by it: on a standalone server, a transaction
 * fails with a driver error ("does not support retryable writes") that is no usable signal.
 */
export const detectTopology = async (client: MongoClient): Promise<MongoDBTopology> =>
	topologyOf(await client.db('admin').command({ hello: 1 }));

const topologyOf = (hello: Document): MongoDBTopology => {
	if (hello.msg === 'isdbgrid') {
		return 'sharded';
	}
	return hello.setName ? 'replica-set' : 'standalone';
};

/**
 * The server behind the MongoDB protocol: MongoDB, or an engine that speaks it without MongoDB's transactions and
 * majority reads underneath, which the gap-safe order rests on:
 * - `'ferretdb'`: FerretDB, on PostgreSQL;
 * - `'documentdb'`: the open-source DocumentDB gateway, on PostgreSQL, and Azure DocumentDB (formerly Azure Cosmos DB
 *   for MongoDB vCore), built on it;
 * - `'amazon-documentdb'`: Amazon DocumentDB, which reports a replica set (`rs0`) whatever its cluster is;
 * - `'cosmos-db'`: Azure Cosmos DB for MongoDB (request units), which reports a replica set (`globaldb`).
 */
export type MongoDBEngine = 'mongodb' | 'ferretdb' | 'documentdb' | 'amazon-documentdb' | 'cosmos-db';

/** The topology and the engine of the server a store is connected to. */
export interface MongoDBServer {
	topology: MongoDBTopology;
	engine: MongoDBEngine;
}

/**
 * Asks the server what it is: its topology (`hello`), and its engine (`detectEngine`).
 * @throws what `hello` throws, such as a connection error
 */
export const detectServer = async (client: MongoClient): Promise<MongoDBServer> => {
	const hello = await client.db('admin').command({ hello: 1 });
	return { topology: topologyOf(hello), engine: await detectEngine(client, hello) };
};

/**
 * The reply of a command, or `undefined` for any error: an engine that lacks it, a missing privilege, Stable API. Every
 * probe answers at once or fails, so `maxTimeMS` only bounds a stalled server.
 */
const replyTo = async (db: Db, command: Document): Promise<Document | undefined> => {
	try {
		return await db.command({ ...command, maxTimeMS: PROBE_TIMEOUT_MS });
	} catch {
		return undefined;
	}
};

const PROBE_TIMEOUT_MS = 5_000;

const succeeded = (reply: Document | undefined): boolean => Number(reply?.ok) === 1;

/** The hosts of the connection string, as the client parsed them (`mongodb+srv://` names one). */
const hostsOf = (client: MongoClient): string[] => {
	const { hosts = [], srvHost } = (client.options ?? {}) as { hosts?: { host?: string }[]; srvHost?: string };
	return [...hosts.map(({ host }) => host ?? ''), srvHost ?? ''].filter(Boolean).map((host) => host.toLowerCase());
};

const AMAZON_DOCUMENTDB_HOST = /\.docdb(-elastic)?\.amazonaws\.com$/;
const AZURE_DOCUMENTDB_HOST = /\.mongocluster\.cosmos\.azure\.(com|cn)$/;
const COSMOS_DB_HOST = /\.(mongo\.cosmos|documents)\.azure\.(com|cn)$/;

/** Amazon DocumentDB's engine version (`3.0.12345`, or `8.0.2+4.0.12345` from 5.0.2 and 8.0.2 on). */
const DOCUMENTDB_ENGINE_VERSION = /^(?:\d+\.\d+\.\d+\+)?[1-4]\.0\.\d+$/;

/**
 * Tells the engine by what the server reports, which no MongoDB server reports:
 * - `hello` has an `internal` document (with `msg: 'isdbgrid'`, or `documentdb_versions`): the DocumentDB gateway; a
 *   `mongos` has none;
 * - `buildInfo` has a `ferretdb` document (FerretDB 2) or `ferretdbVersion` (FerretDB 1);
 * - `getEngineVersion` answers an `engineVersion`: Amazon DocumentDB;
 * - `getLastRequestStatistics` answers a `RequestCharge`: Azure Cosmos DB for MongoDB.
 *
 * MongoDB answers both vendor commands with `CommandNotFound`, and is asked them only on a replica set with the
 * vendor's set name (`rs0`, `globaldb`) or on a host of the vendor's. A command that fails is no signal. Without a
 * signal, the host names of the managed services decide; else it is MongoDB.
 */
export const detectEngine = async (client: MongoClient, hello: Document): Promise<MongoDBEngine> => {
	const internal = hello.internal;
	if (
		(hello.msg === 'isdbgrid' && typeof internal === 'object' && internal !== null) ||
		Array.isArray(internal?.documentdb_versions)
	) {
		return 'documentdb';
	}
	const buildInfo = await replyTo(client.db('admin'), { buildInfo: 1 });
	if (
		(typeof buildInfo?.ferretdb === 'object' && buildInfo.ferretdb !== null) ||
		typeof buildInfo?.ferretdbVersion === 'string'
	) {
		return 'ferretdb';
	}

	const hosts = hostsOf(client);
	const onHost = (pattern: RegExp) => hosts.some((host) => pattern.test(host));
	// On the store's database: the vendors' samples run their commands there, not on admin
	if (hello.setName === 'rs0' || onHost(AMAZON_DOCUMENTDB_HOST)) {
		const reply = await replyTo(client.db(), { getEngineVersion: 1 });
		if (succeeded(reply) && DOCUMENTDB_ENGINE_VERSION.test(String(reply?.engineVersion))) {
			return 'amazon-documentdb';
		}
	}
	if (hello.setName === 'globaldb' || onHost(COSMOS_DB_HOST)) {
		const reply = await replyTo(client.db(), { getLastRequestStatistics: 1 });
		if (succeeded(reply) && typeof reply?.RequestCharge === 'number') {
			return 'cosmos-db';
		}
	}

	if (onHost(AMAZON_DOCUMENTDB_HOST)) {
		return 'amazon-documentdb';
	}
	if (onHost(AZURE_DOCUMENTDB_HOST)) {
		return 'documentdb';
	}
	if (onHost(COSMOS_DB_HOST)) {
		return 'cosmos-db';
	}
	return 'mongodb';
};

/**
 * The capabilities of the event store per topology and engine (ADR 0002 §4). `'gap-safe'` rests on the transaction
 * that updates the pool's counter first, and on majority reads; only MongoDB replica sets have the evidence
 * (`read-all-gap-safe`). Any other engine gets `'best-effort'`, whatever topology it reports. FerretDB and Azure Cosmos
 * DB for MongoDB have no transaction that spans the catalog and a pool, and neither has an elastic Amazon DocumentDB
 * cluster (a `mongos`): their appends aren't atomic.
 */
export const capabilitiesOf = (
	topology: MongoDBTopology,
	engine: MongoDBEngine = 'mongodb',
): Required<EventStoreCapabilities> => {
	const capabilities: Required<EventStoreCapabilities> =
		topology === 'replica-set'
			? { atomicAppend: true, headers: true, globalOrder: 'gap-safe' }
			: topology === 'sharded'
				? { atomicAppend: true, headers: true, globalOrder: 'best-effort' }
				: { atomicAppend: false, headers: true, globalOrder: 'best-effort' };
	if (engine === 'mongodb') {
		return capabilities;
	}
	const atomicAppend =
		capabilities.atomicAppend &&
		engine !== 'ferretdb' &&
		engine !== 'cosmos-db' &&
		!(engine === 'amazon-documentdb' && topology === 'sharded');
	return { ...capabilities, atomicAppend, globalOrder: 'best-effort' };
};

const ENGINE_NAMES: Record<Exclude<MongoDBEngine, 'mongodb'>, string> = {
	ferretdb: 'FerretDB',
	documentdb: 'DocumentDB',
	'amazon-documentdb': 'Amazon DocumentDB',
	'cosmos-db': 'Azure Cosmos DB for MongoDB',
};

const warnedEngines = new Set<MongoDBEngine>();

/** Warns once per process and engine that a server other than MongoDB gets `'best-effort'`. */
export const warnEngineOnce = (engine: MongoDBEngine, logger: Logger): void => {
	if (engine === 'mongodb' || warnedEngines.has(engine)) {
		return;
	}
	warnedEngines.add(engine);
	const transactions =
		engine === 'ferretdb' || engine === 'cosmos-db'
			? ' It has no transaction that spans two collections, so appends are not atomic (atomicAppend: false).'
			: '';
	logger.warn(
		`Connected to ${ENGINE_NAMES[engine]}, which speaks the MongoDB protocol but is not MongoDB: globalOrder is 'best-effort', whatever topology it reports.${transactions} It is not a tested server of this store.`,
	);
};

let warnedStandalone = false;

/**
 * Warns once per process that a standalone server can't give atomic appends or a gap-safe order.
 */
export const warnStandaloneOnce = (logger: Logger): void => {
	if (warnedStandalone) {
		return;
	}
	warnedStandalone = true;
	logger.warn(
		'Connected to a standalone MongoDB server: appends are not atomic, a failed append leaves holes in the global positions, and readAll may miss events that commit late (globalOrder: best-effort). Run MongoDB as a replica set (a single-node replica set is enough) for atomic appends and a gap-safe global order.',
	);
};
