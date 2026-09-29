// Writes the cross-version corpus (corpus.mjs) with the published 3.0.2 packages, then reads it back with them and
// records what 3.0.2 returned in a manifest. The master specs (packages/integration/<db>/tests/cross-version) must
// read the same data the same way, and from schema v2 on migrate it first.
//
//   TZ=America/New_York node writer.mjs --database <postgres|mariadb|mongodb> --namespace xv_<run> \
//     [--url <mongodb url naming the namespace>] --out <manifest.json>
//
// It runs a real NestJS 11 application context (EventSourcingModule.forRootAsync) on the namespace, which
// namespace.mjs creates first. scripts/test-cross-version.mjs runs the whole sequence.
import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
	EventEnvelope,
	EventId,
	EventMap,
	EventSourcingModule,
	EventStore,
	EventStream,
	Id,
	SnapshotStore,
	SnapshotStream,
} from '@ocoda/event-sourcing';
import { MariaDBEventStore, MariaDBSnapshotStore } from '@ocoda/event-sourcing-mariadb';
import { MongoDBEventStore, MongoDBSnapshotStore } from '@ocoda/event-sourcing-mongodb';
import { PostgresEventStore, PostgresSnapshotStore } from '@ocoda/event-sourcing-postgres';
import pg from 'pg';
import { ALL_ENVELOPES_SINCE, buildCorpus, LEGACY_POOL, LONG_POOL, WRITER_TIME_ZONE } from './corpus.mjs';
import { AGGREGATES, EVENTS } from './domain.mjs';
import { applyPostgresIndexVariants, openLegacyMariaDBStores } from './legacy-ddl.mjs';
import { openClient, parseDatabase, parseNamespace, storeOptions } from './namespace.mjs';

const MANIFEST_FORMAT = 1;

const DRIVERS = {
	postgres: { EventStoreDriver: PostgresEventStore, SnapshotStoreDriver: PostgresSnapshotStore },
	mariadb: { EventStoreDriver: MariaDBEventStore, SnapshotStoreDriver: MariaDBSnapshotStore },
	mongodb: { EventStoreDriver: MongoDBEventStore, SnapshotStoreDriver: MongoDBSnapshotStore },
};

/**
 * A JSON form of a value that keeps what JSON loses: classes (`$class`, the constructor name, `Object` for plain
 * objects), Dates vs strings, `undefined`. packages/testing/cross-version/manifest.ts `encodeValue` is the same
 * function for the master reader. Change both together.
 */
export const encodeValue = (value) => {
	if (value === undefined) return { $undefined: true };
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number')
		return Number.isFinite(value) && !Object.is(value, -0) ? value : { $number: String(value) };
	if (typeof value === 'bigint') return { $bigint: value.toString() };
	if (value instanceof Date) return { $date: Number.isNaN(value.getTime()) ? null : value.toISOString() };
	if (Array.isArray(value)) return value.map(encodeValue);
	if (typeof value === 'object') {
		const prototype = Object.getPrototypeOf(value);
		return {
			$class:
				prototype === null ? null : prototype === Object.prototype ? 'Object' : (prototype.constructor?.name ?? '?'),
			fields: Object.fromEntries(Object.keys(value).map((key) => [key, encodeValue(value[key])])),
		};
	}
	return { $unsupported: typeof value };
};

const encodeEventEnvelope = ({ event, payload, metadata }) => ({
	event,
	payload: encodeValue(payload),
	metadata: encodeValue({ ...metadata, eventId: metadata.eventId.value }),
});

const encodeSnapshotEnvelope = (envelope) =>
	envelope ? { payload: encodeValue(envelope.payload), metadata: encodeValue(envelope.metadata) } : null;

const collect = async (generator) => {
	const items = [];
	for await (const batch of generator) items.push(...batch);
	return items;
};

const installedVersion = (name) =>
	JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), 'utf8')).version;

const serverVersion = async (database, client) => {
	switch (database) {
		case 'postgres':
			return (await client.query('SHOW server_version'))[0].server_version;
		case 'mariadb':
			return (await client.query('SELECT VERSION() AS version'))[0].version;
		case 'mongodb':
			return (await client.db.admin().command({ buildInfo: 1 })).version;
	}
};

/** The schema as found after the writes, for the migration specs of schema v2. */
const describeSchema = async (database, client) => {
	switch (database) {
		case 'postgres':
			return undefined; // the index variants, see applyPostgresIndexVariants
		case 'mariadb': {
			const tables = {};
			for (const row of await client.query('SHOW TABLES')) {
				const table = Object.values(row)[0];
				tables[table] = (await client.query(`SHOW CREATE TABLE \`${table}\``))[0]['Create Table'];
			}
			return { tables };
		}
		case 'mongodb': {
			const indexes = {};
			for (const { name } of await client.db.listCollections({}, { nameOnly: true }).toArray()) {
				indexes[name] = (await client.db.collection(name).indexes()).map(({ name: index, key, unique }) => ({
					name: index,
					key,
					unique: Boolean(unique),
				}));
			}
			return { indexes };
		}
	}
};

/** Flags `version` of a stream as its latest snapshot too (a second flag), or clears every flag (`version: null`). */
const setLatestFlag = async (database, client, collection, streamId, version) => {
	const latest = version === null ? null : `latest#${streamId}`;
	switch (database) {
		case 'postgres':
			return version === null
				? client.query(`UPDATE ${pg.escapeIdentifier(collection)} SET latest = NULL WHERE stream_id = $1`, [streamId])
				: client.query(
						`UPDATE ${pg.escapeIdentifier(collection)} SET latest = $1 WHERE stream_id = $2 AND version = $3`,
						[latest, streamId, version],
					);
		case 'mariadb':
			return version === null
				? client.query(`UPDATE \`${collection}\` SET latest = NULL WHERE stream_id = ?`, [streamId])
				: client.query(`UPDATE \`${collection}\` SET latest = ? WHERE stream_id = ? AND version = ?`, [
						latest,
						streamId,
						version,
					]);
		case 'mongodb':
			return version === null
				? client.db.collection(collection).updateMany({ streamId }, { $set: { latest: null } })
				: client.db.collection(collection).updateOne({ streamId, version }, { $set: { latest } });
	}
};

/** Groups the entries of 3.x `getAllEnvelopes` whose event ids are equal: their relative order is undefined. */
const markTies = (entries) => {
	const counts = new Map();
	for (const { eventId } of entries) counts.set(eventId, (counts.get(eventId) ?? 0) + 1);
	return entries.map((entry) => (counts.get(entry.eventId) > 1 ? { ...entry, tie: true } : entry));
};

const main = async () => {
	const { values } = parseArgs({
		options: {
			database: { type: 'string' },
			namespace: { type: 'string' },
			url: { type: 'string' },
			out: { type: 'string' },
		},
	});
	const database = parseDatabase(values.database);
	const target = { database, namespace: parseNamespace(values.namespace), url: values.url };
	if (!values.out) throw new Error('--out <manifest.json> is required');

	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	if (timeZone !== WRITER_TIME_ZONE) {
		throw new Error(`Run the writer with TZ=${WRITER_TIME_ZONE} (the process time zone is ${timeZone})`);
	}

	const options = storeOptions(target);
	const { EventStoreDriver, SnapshotStoreDriver } = DRIVERS[database];

	class CrossVersionWriterModule {}
	Module({
		imports: [
			EventSourcingModule.forRootAsync({
				useFactory: () => ({
					events: EVENTS,
					eventStore: { driver: EventStoreDriver, ...options },
					snapshotStore: { driver: SnapshotStoreDriver, ...options },
				}),
			}),
		],
	})(CrossVersionWriterModule);

	const app = await NestFactory.createApplicationContext(CrossVersionWriterModule, { logger: ['error', 'warn'] });
	const client = await openClient(target);
	let legacy;
	try {
		const eventStore = app.get(EventStore);
		const snapshotStore = app.get(SnapshotStore);
		const eventMap = app.get(EventMap);
		const corpus = buildCorpus(database);

		if (corpus.eventPools.some(({ legacy }) => legacy)) {
			legacy = await openLegacyMariaDBStores({ client, eventMap, options, pool: LEGACY_POOL });
		}
		for (const { pool, legacy: isLegacy } of corpus.eventPools) {
			if (pool && !isLegacy) await eventStore.ensureCollection(pool);
		}
		for (const { pool, legacy: isLegacy } of corpus.snapshotPools) {
			if (pool && !isLegacy) await snapshotStore.ensureCollection(pool);
		}

		// Events: pre-built envelopes, then the repository commit() path.
		const eventPools = [];
		for (const pool of corpus.eventPools) {
			const store = pool.legacy ? legacy.eventStore : eventStore;
			const written = [];
			const record = (eventStream, envelopes) =>
				written.push(
					...envelopes.map(({ metadata }) => ({
						streamId: eventStream.streamId,
						aggregateId: metadata.aggregateId,
						version: metadata.version,
						eventId: metadata.eventId.value,
						occurredOn: metadata.occurredOn.toISOString(),
					})),
				);

			for (const stream of pool.streams) {
				const eventStream = EventStream.for(AGGREGATES[stream.aggregate], Id.from(stream.aggregateId));
				for (const append of stream.appends) {
					const envelopes = append.map(({ event, version, eventId, correlationId, causationId }) =>
						EventEnvelope.create(eventMap.getName(event), eventMap.serializeEvent(event), {
							aggregateId: stream.envelopeAggregateId ?? stream.aggregateId,
							version,
							eventId: EventId.from(eventId),
							...(correlationId === undefined ? {} : { correlationId }),
							...(causationId === undefined ? {} : { causationId }),
						}),
					);
					record(eventStream, await store.appendEvents(eventStream, append.at(-1).version, envelopes, pool.pool));
				}
			}
			for (const stream of pool.commitStreams) {
				const eventStream = EventStream.for(AGGREGATES[stream.aggregate], Id.from(stream.aggregateId));
				let aggregate;
				for (const change of stream.commits) {
					aggregate = change(aggregate);
					const events = aggregate.commit();
					record(eventStream, await store.appendEvents(eventStream, aggregate.version, events, pool.pool));
				}
			}

			eventPools.push({ pool, written });
		}

		// Snapshots, then the flag damage 3.x can leave behind.
		const snapshotPools = [];
		for (const pool of corpus.snapshotPools) {
			const store = pool.legacy ? legacy.snapshotStore : snapshotStore;
			const written = [];
			for (const stream of pool.streams) {
				const snapshotStream = SnapshotStream.for(AGGREGATES[stream.aggregate], Id.from(stream.aggregateId));
				for (const { version, payload } of stream.snapshots) {
					const { metadata } = await store.appendSnapshot(snapshotStream, version, payload, pool.pool);
					written.push({
						streamId: snapshotStream.streamId,
						aggregateId: metadata.aggregateId,
						version: metadata.version,
						snapshotId: metadata.snapshotId,
						registeredOn: metadata.registeredOn.toISOString(),
					});
				}
			}

			const collection = pool.pool ? `${pool.pool}-snapshots` : 'snapshots';
			const streamIdOf = (index) =>
				SnapshotStream.for(AGGREGATES[pool.streams[index].aggregate], Id.from(pool.streams[index].aggregateId))
					.streamId;
			const duplicateLatest = [];
			for (const { streamIndex, version } of pool.duplicateLatest) {
				const streamId = streamIdOf(streamIndex);
				await setLatestFlag(database, client, collection, streamId, version);
				const versions = pool.streams[streamIndex].snapshots.map((snapshot) => snapshot.version);
				duplicateLatest.push({ streamId, flaggedVersions: [version, versions.at(-1)] });
			}
			const missingLatest = [];
			for (const { streamIndex } of pool.missingLatest) {
				const streamId = streamIdOf(streamIndex);
				await setLatestFlag(database, client, collection, streamId, null);
				missingLatest.push(streamId);
			}

			snapshotPools.push({ pool, written, duplicateLatest, missingLatest });
		}

		const postgresIndexes =
			database === 'postgres'
				? await applyPostgresIndexVariants(client, {
						tenantPool: 'tenant-a',
						bareCollections: [`${LONG_POOL}-events`, `${LONG_POOL}-snapshots`],
					})
				: undefined;

		// Read everything back through 3.0.2.
		const manifest = {
			format: MANIFEST_FORMAT,
			database,
			namespace: target.namespace,
			writerTimeZone: WRITER_TIME_ZONE,
			writer: {
				node: process.version,
				packages: Object.fromEntries(
					[
						'@ocoda/event-sourcing',
						`@ocoda/event-sourcing-${database}`,
						'@nestjs/core',
						'class-transformer',
						{ postgres: 'pg', mariadb: 'mariadb', mongodb: 'mongodb' }[database],
					].map((name) => [name, installedVersion(name)]),
				),
				server: await serverVersion(database, client),
			},
			allEnvelopesSince: ALL_ENVELOPES_SINCE,
			eventCollections: await collect(eventStore.listCollections()),
			snapshotCollections: await collect(snapshotStore.listCollections()),
			eventPools: [],
			snapshotPools: [],
			schema: postgresIndexes ? { indexes: postgresIndexes } : await describeSchema(database, client),
			legacyDdl: legacy?.ddl,
		};

		for (const [index, { pool, written }] of eventPools.entries()) {
			const corpusPool = corpus.eventPools[index];
			const streams = [];
			for (const stream of [...corpusPool.streams, ...corpusPool.commitStreams]) {
				const eventStream = EventStream.for(AGGREGATES[stream.aggregate], Id.from(stream.aggregateId));
				streams.push({
					aggregate: stream.aggregate,
					aggregateId: stream.aggregateId,
					streamId: eventStream.streamId,
					envelopes: (await collect(eventStore.getEnvelopes(eventStream, { pool: pool.pool }))).map(
						encodeEventEnvelope,
					),
					events: (await collect(eventStore.getEvents(eventStream, { pool: pool.pool }))).map(encodeValue),
				});
			}
			const all = await collect(eventStore.getAllEnvelopes({ pool: pool.pool, since: ALL_ENVELOPES_SINCE }));
			const streamIds = (predicate) =>
				corpusPool.streams
					.filter(predicate)
					.map((stream) => EventStream.for(AGGREGATES[stream.aggregate], Id.from(stream.aggregateId)).streamId);
			const eventIdCounts = new Map();
			for (const { eventId } of written) eventIdCounts.set(eventId, (eventIdCounts.get(eventId) ?? 0) + 1);

			manifest.eventPools.push({
				pool: pool.pool ?? null,
				collection: pool.pool ? `${pool.pool}-events` : 'events',
				written,
				streams,
				legacyAllOrder: markTies(
					all.map(({ metadata }) => ({
						eventId: metadata.eventId.value,
						aggregateId: metadata.aggregateId,
						version: metadata.version,
					})),
				),
				gappedStreams: streamIds((stream) => stream.gapped),
				caseVariantStreams: streamIds((stream) => stream.caseVariant),
				duplicateEventIds: [...eventIdCounts].filter(([, count]) => count > 1).map(([eventId]) => eventId),
			});
		}

		for (const [index, { pool, written, duplicateLatest, missingLatest }] of snapshotPools.entries()) {
			const streams = [];
			for (const stream of corpus.snapshotPools[index].streams) {
				const snapshotStream = SnapshotStream.for(AGGREGATES[stream.aggregate], Id.from(stream.aggregateId));
				streams.push({
					aggregate: stream.aggregate,
					aggregateId: stream.aggregateId,
					streamId: snapshotStream.streamId,
					envelopes: (await collect(snapshotStore.getEnvelopes(snapshotStream, { pool: pool.pool }))).map(
						encodeSnapshotEnvelope,
					),
					last: encodeSnapshotEnvelope(await snapshotStore.getLastEnvelope(snapshotStream, pool.pool)),
				});
			}
			manifest.snapshotPools.push({
				pool: pool.pool ?? null,
				collection: pool.pool ? `${pool.pool}-snapshots` : 'snapshots',
				written,
				streams,
				duplicateLatest,
				missingLatest,
			});
		}

		writeFileSync(values.out, `${JSON.stringify(manifest, null, '\t')}\n`);
		const events = manifest.eventPools.reduce((sum, { written }) => sum + written.length, 0);
		const snapshots = manifest.snapshotPools.reduce((sum, { written }) => sum + written.length, 0);
		console.log(
			`3.0.2 wrote ${events} events and ${snapshots} snapshots into ${database} ${target.namespace} (${manifest.writer.server}); manifest: ${values.out}`,
		);
	} finally {
		await legacy?.close();
		await client.close();
		await app.close();
	}
};

await main();
