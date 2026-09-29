import { randomBytes } from 'node:crypto';
import {
	EventCollection,
	EventCollectionNotFoundException,
	EventEnvelope,
	EventId,
	EventStoreCollectionCreationException,
	EventStoreSchemaException,
	EventStoreVersionConflictException,
	EventStream,
	ExpectedVersion,
	type IEventPool,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import { MongoDBEventStore } from '@ocoda/event-sourcing-mongodb';
import { Account, AccountId, getEventMap, getEvents, mongodbTestTopologies } from '@ocoda/event-sourcing-testing/unit';
import { Collection, Db, Long, MongoClient } from 'mongodb';
import { V1_EVENT_INDEXES, v1EventDocument } from '../fixtures/schema-v1.js';
import { drain, expectRejectionOfClass } from '../support/assertions.js';
import { CATALOG, dropCollections, rawCollection } from '../support/catalog.js';
import { type TestEventStore, createEventStore } from '../support/stores.js';

const uniquePool = (name: string): IEventPool => `mongo-${name}-${randomBytes(4).toString('hex')}`;

/** A URL of the same server with another database, for the specs that need a database without a catalog. */
const withDatabase = (url: string, database: string): string => {
	const parsed = new URL(url);
	parsed.pathname = `/${database}`;
	return parsed.toString();
};

describe.each(mongodbTestTopologies())(`${MongoDBEventStore.name} ($name)`, ({ name, url }) => {
	const eventMap = getEventMap();
	const events = getEvents();

	let eventStore: MongoDBEventStore;
	let publish: TestEventStore['publish'];
	let database: Db;
	const pools: IEventPool[] = [];

	const newPool = async (label: string, store: MongoDBEventStore = eventStore): Promise<IEventPool> => {
		const pool = uniquePool(label);
		pools.push(pool);
		await store.ensureCollection(pool);
		return pool;
	};
	const reservePool = (label: string): IEventPool => {
		const pool = uniquePool(label);
		pools.push(pool);
		return pool;
	};
	const newStream = () => EventStream.for(Account, AccountId.generate());
	const catalog = () =>
		database.collection<{ _id: string; kind: string; schemaVersion?: number; lastPosition?: unknown }>(CATALOG);

	beforeAll(async () => {
		({ store: eventStore, publish } = createEventStore({ url }, eventMap));
		await eventStore.connect();
		database = eventStore['database'];
	});

	afterAll(async () => {
		await dropCollections(
			database,
			pools.map((pool) => EventCollection.get(pool)),
		);
		await eventStore.disconnect();
	});

	it('claims the capabilities of its topology', () => {
		expect(eventStore.capabilities).toEqual(
			name === 'replica-set'
				? { atomicAppend: true, headers: true, globalOrder: 'gap-safe' }
				: { atomicAppend: false, headers: true, globalOrder: 'best-effort' },
		);
	});

	describe('appending', () => {
		it('stores schema v2 documents with a 64-bit position, and publishes the envelopes', async () => {
			const pool = await newPool('documents');
			const stream = newStream();

			const envelopes = await eventStore.appendEvents(stream, events, {
				expectedVersion: ExpectedVersion.NoStream,
				pool,
				metadata: { correlationId: 'correlation', causationId: 'causation', headers: { tenant: 'acme', retries: 2 } },
			});

			expect(envelopes.map(({ metadata }) => metadata.globalPosition)).toEqual(
				events.map((_, index) => BigInt(index + 1)),
			);
			const documents = await rawCollection(database, EventCollection.get(pool))
				.find({}, { promoteLongs: false })
				.sort({ globalPosition: 1 })
				.toArray();
			expect(documents).toHaveLength(events.length);
			for (const [index, document] of documents.entries()) {
				const { metadata, event, payload } = envelopes[index];
				expect(document).toEqual({
					_id: metadata.eventId.value,
					streamId: stream.streamId,
					event,
					payload,
					aggregateId: stream.aggregateId,
					version: index + 1,
					occurredOn: metadata.occurredOn,
					correlationId: 'correlation',
					causationId: 'causation',
					globalPosition: Long.fromNumber(index + 1),
					headers: { tenant: 'acme', retries: 2 },
				});
			}
			expect(
				await rawCollection(database, EventCollection.get(pool)).countDocuments({ globalPosition: { $type: 'long' } }),
			).toBe(events.length);
			expect(publish).toHaveBeenCalledTimes(events.length);
		});

		it('leaves absent metadata out of the documents, and keeps the event version of pre-built envelopes', async () => {
			const pool = await newPool('absent');
			const stream = newStream();
			const envelope = EventEnvelope.from(eventMap.getName(events[0]), eventMap.serializeEvent(events[0]), {
				eventId: EventId.generate(),
				aggregateId: stream.aggregateId,
				version: 1,
				occurredOn: new Date('2024-02-29T12:00:00.123Z'),
				eventVersion: 3,
			});

			await eventStore.appendEvents(stream, [envelope, events[1]], { expectedVersion: 0, pool });

			const [first, second] = await rawCollection(database, EventCollection.get(pool))
				.find()
				.sort({ version: 1 })
				.toArray();
			expect(first).not.toHaveProperty('correlationId');
			expect(first).not.toHaveProperty('headers');
			expect(first).toMatchObject({ eventVersion: 3, occurredOn: new Date('2024-02-29T12:00:00.123Z') });
			expect(second).not.toHaveProperty('eventVersion');
			expect(second).not.toHaveProperty('eventDate');

			const read = await drain(eventStore.getEnvelopes(stream, { pool }));
			expect(read.map(({ metadata }) => metadata)).toEqual([
				expect.objectContaining({ eventVersion: 3, globalPosition: 1n }),
				expect.not.objectContaining({ eventVersion: expect.anything() }),
			]);
			expect(Object.keys(read[1].metadata)).not.toContain('correlationId');
		});

		it('numbers each pool on its own, across streams', async () => {
			const [poolA, poolB] = [await newPool('numbering-a'), await newPool('numbering-b')];
			const [streamA, streamB] = [newStream(), newStream()];

			await eventStore.appendEvents(streamA, events.slice(0, 2), { expectedVersion: 0, pool: poolA });
			await eventStore.appendEvents(streamB, events.slice(0, 3), { expectedVersion: 0, pool: poolA });
			const inB = await eventStore.appendEvents(streamA, events.slice(0, 1), { expectedVersion: 0, pool: poolB });
			const next = await eventStore.appendEvents(streamA, events.slice(2, 4), { expectedVersion: 2, pool: poolA });

			expect(inB.map(({ metadata }) => metadata.globalPosition)).toEqual([1n]);
			expect(next.map(({ metadata }) => metadata.globalPosition)).toEqual([6n, 7n]);
			expect(await catalog().findOne({ _id: EventCollection.get(poolA) })).toMatchObject({
				kind: 'events',
				schemaVersion: 2,
				lastPosition: 7,
			});
		});

		it('rejects an append at a version the stream is not at, with the version of the stream', async () => {
			const pool = await newPool('conflict');
			const stream = newStream();
			await eventStore.appendEvents(stream, events.slice(0, 3), { expectedVersion: 0, pool });

			await expectRejectionOfClass(
				eventStore.appendEvents(stream, events.slice(3, 4), { expectedVersion: 2, pool }),
				EventStoreVersionConflictException,
				{ streamId: stream.streamId, expectedVersion: 2, actualVersion: 3, pool },
			);
		});
	});

	describe('reading', () => {
		let pool: IEventPool;
		const stream = newStream();
		const other = newStream();

		beforeAll(async () => {
			pool = await newPool('reading');
			await eventStore.appendEvents(stream, events, { expectedVersion: 0, pool, metadata: { headers: { a: null } } });
			await eventStore.appendEvents(other, events.slice(0, 2), { expectedVersion: 0, pool });
		});

		it('reads the version of a stream, 0 when it has no events', async () => {
			await expect(eventStore.getStreamVersion(stream, pool)).resolves.toBe(events.length);
			await expect(eventStore.getStreamVersion(newStream(), pool)).resolves.toBe(0);
		});

		it('reads envelopes with their position and headers, in version order either way', async () => {
			const envelope = await eventStore.getEnvelope(stream, 2, pool);
			expect(envelope.metadata).toMatchObject({ version: 2, globalPosition: 2n, headers: { a: null } });
			expect(envelope.metadata.eventId).toBeInstanceOf(EventId);

			const backward = await drain(
				eventStore.getEnvelopes(stream, { pool, direction: StreamReadingDirection.BACKWARD, fromVersion: 3, limit: 2 }),
			);
			expect(backward.map(({ metadata }) => metadata.version)).toEqual([events.length, events.length - 1]);
			await expect(drain(eventStore.getEvents(stream, { pool, batch: 2 }))).resolves.toEqual(events);
		});

		it('reads the pool in the order of the positions, in batches, from an inclusive position', async () => {
			const all = await drain(eventStore.readAll({ pool }));
			expect(all.map(({ metadata }) => metadata.globalPosition)).toEqual(
				Array.from({ length: events.length + 2 }, (_, index) => BigInt(index + 1)),
			);

			const batches: bigint[][] = [];
			for await (const batch of eventStore.readAll({ pool, fromPosition: 3n, batch: 2 })) {
				batches.push(batch.map(({ metadata }) => metadata.globalPosition as bigint));
			}
			expect(batches).toEqual([
				[3n, 4n],
				[5n, 6n],
				[7n, 8n],
			]);
			await expect(drain(eventStore.readAll({ pool, fromPosition: 100n }))).resolves.toEqual([]);
			await expect(eventStore.readAll({ pool, batch: 0 }).next()).rejects.toThrow(RangeError);
		});

		it('rejects reads of a pool the catalog does not register, and remembers the pools it does', async () => {
			const unknown = reservePool('unregistered');
			const fields = { collection: EventCollection.get(unknown), pool: unknown };
			await expectRejectionOfClass(
				eventStore.getStreamVersion(stream, unknown),
				EventCollectionNotFoundException,
				fields,
			);
			await expectRejectionOfClass(
				eventStore.getEnvelope(stream, 1, unknown),
				EventCollectionNotFoundException,
				fields,
			);
			await expectRejectionOfClass(
				drain(eventStore.getEnvelopes(stream, { pool: unknown })),
				EventCollectionNotFoundException,
				fields,
			);
			await expectRejectionOfClass(
				drain(eventStore.readAll({ pool: unknown })),
				EventCollectionNotFoundException,
				fields,
			);

			// A collection that holds events but isn't registered is still unknown when a read finds nothing
			await rawCollection(database, EventCollection.get(unknown)).insertOne({ streamId: 'x', version: 1 });
			await expectRejectionOfClass(
				eventStore.getStreamVersion(stream, unknown),
				EventCollectionNotFoundException,
				fields,
			);

			// Every call gets a new Collection object, so the catalog's lookups are told apart by the collection's name
			const registered = await newPool('registered');
			const findOne = vi.spyOn(Collection.prototype, 'findOne');
			const catalogLookups = () =>
				findOne.mock.contexts.filter((context) => (context as Collection).collectionName === CATALOG).length;
			await expect(drain(eventStore.readAll({ pool: registered }))).resolves.toEqual([]);
			await expect(eventStore.getStreamVersion(stream, registered)).resolves.toBe(0);
			await expect(drain(eventStore.getEnvelopes(stream, { pool: registered }))).resolves.toEqual([]);
			expect(catalogLookups()).toBe(0);
		});

		it('picks up a pool that another store registers after a read rejected it', async () => {
			const later = reservePool('later');
			await expectRejectionOfClass(eventStore.getStreamVersion(stream, later), EventCollectionNotFoundException);

			const { store: other } = createEventStore({ url }, eventMap);
			await other.connect();
			try {
				await other.ensureCollection(later);
			} finally {
				await other.disconnect();
			}

			await expect(eventStore.getStreamVersion(stream, later)).resolves.toBe(0);
			await expect(drain(eventStore.readAll({ pool: later }))).resolves.toEqual([]);
			const [appended] = await eventStore.appendEvents(stream, events.slice(0, 1), { expectedVersion: 0, pool: later });
			expect(appended.metadata.globalPosition).toBe(1n);
		});

		it("reads the version of a stream from the primary, whatever the client's read preference", async () => {
			const find = vi.spyOn(Collection.prototype, 'find');
			await eventStore.getStreamVersion(stream, pool);

			expect(find).toHaveBeenCalledWith(
				{ streamId: stream.streamId },
				expect.objectContaining({ readPreference: 'primary' }),
			);
		});

		it('rejects documents without a position (a 3.x collection read without migrating) with a schema error', async () => {
			const legacy = reservePool('legacy-read');
			await rawCollection(database, EventCollection.get(legacy)).insertOne(v1EventDocument(stream, 1));

			await expectRejectionOfClass(eventStore.getEnvelope(stream, 1, legacy), EventStoreSchemaException, {
				collection: EventCollection.get(legacy),
				found: 'v1',
			});
		});
	});

	describe('ensureCollection', () => {
		it('creates a collection with the validator and the unique indexes, and registers it', async () => {
			const pool = await newPool('create');
			const collection = EventCollection.get(pool);

			const [info] = await database.listCollections({ name: collection }).toArray();
			expect((info as { options: object }).options).toMatchObject({
				validator: {
					$jsonSchema: {
						bsonType: 'object',
						required: ['globalPosition', 'streamId', 'version'],
						properties: { globalPosition: { bsonType: 'long' } },
					},
				},
				validationLevel: 'strict',
				validationAction: 'error',
			});
			const indexes = await rawCollection(database, collection).indexes();
			expect(indexes.filter(({ unique }) => unique).map(({ key }) => key)).toEqual([
				{ streamId: 1, version: 1 },
				{ globalPosition: 1 },
			]);
			expect(await catalog().findOne({ _id: collection })).toEqual({
				_id: collection,
				kind: 'events',
				schemaVersion: 2,
				lastPosition: 0,
			});
			// A 3.x-shaped insert fails
			await expect(
				rawCollection(database, collection).insertOne(v1EventDocument(newStream(), 1)),
			).rejects.toMatchObject({
				code: 121,
			});
		});

		it('recreates a registered collection that was dropped, and keeps its counter', async () => {
			const pool = await newPool('recreate');
			const collection = EventCollection.get(pool);
			await eventStore.appendEvents(newStream(), events.slice(0, 3), { expectedVersion: 0, pool });
			await database.dropCollection(collection);

			await expect(eventStore.ensureCollection(pool)).resolves.toBe(collection);

			const [envelope] = await eventStore.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool });
			expect(envelope.metadata.globalPosition).toBe(4n);
		});

		it('restores the validator and the unique indexes of a registered collection that an append created again', async () => {
			const pool = await newPool('implicit');
			const collection = EventCollection.get(pool);
			const uniqueKeys = async () =>
				(await rawCollection(database, collection).indexes()).filter(({ unique }) => unique).map(({ key }) => key);
			const validatorOf = async () =>
				((await database.listCollections({ name: collection }).toArray())[0] as { options: { validator?: object } })
					.options.validator;
			// Dropped while the store ran: the next append creates it implicitly, without validator and unique indexes
			await database.dropCollection(collection);
			await eventStore.appendEvents(newStream(), events.slice(0, 2), { expectedVersion: 0, pool });
			expect(await uniqueKeys()).toEqual([]);
			expect(await validatorOf()).toBeUndefined();

			// With ddl: 'none', the store names the statements that restore them
			const { store: checking } = createEventStore({ url, ddl: 'none' }, eventMap);
			await checking.connect();
			try {
				const error = await expectRejectionOfClass(
					checking.ensureCollection(pool),
					EventStoreCollectionCreationException,
					{ collection },
				);
				expect((error.cause as Error).message).toContain(`db.runCommand({ collMod: '${collection}'`);
				expect((error.cause as Error).message).toContain(`db.getCollection('${collection}').createIndexes(`);
			} finally {
				await checking.disconnect();
			}

			const warn = vi.spyOn(eventStore['logger'], 'warn').mockImplementation(() => undefined);
			await expect(eventStore.ensureCollection(pool)).resolves.toBe(collection);

			expect(warn).toHaveBeenCalledWith(expect.stringContaining('restoring them'));
			expect(await uniqueKeys()).toEqual([{ streamId: 1, version: 1 }, { globalPosition: 1 }]);
			expect(await validatorOf()).toMatchObject({
				$jsonSchema: { required: ['globalPosition', 'streamId', 'version'] },
			});
			const stream = newStream();
			await eventStore.appendEvents(stream, events.slice(0, 1), { expectedVersion: 0, pool });
			await expect(
				eventStore.appendEvents(stream, events.slice(0, 1), { expectedVersion: 0, pool }),
			).rejects.toBeInstanceOf(EventStoreVersionConflictException);
		});

		it('adds the validator to a collection that an insert created while the store created it', async () => {
			const pool = reservePool('created-meanwhile');
			const collection = EventCollection.get(pool);
			const createCollection = Db.prototype.createCollection;
			vi.spyOn(Db.prototype, 'createCollection').mockImplementationOnce(async function (
				this: Db,
				...args: Parameters<Db['createCollection']>
			) {
				// What an insert does to a missing collection
				await createCollection.call(this, collection);
				return createCollection.apply(this, args);
			} as never);

			await expect(eventStore.ensureCollection(pool)).resolves.toBe(collection);

			const [info] = await database.listCollections({ name: collection }).toArray();
			expect((info as { options: object }).options).toMatchObject({
				validator: { $jsonSchema: { required: ['globalPosition', 'streamId', 'version'] } },
				validationLevel: 'strict',
			});
		});

		it('heals a counter that fell behind the events of its collection', async () => {
			const pool = await newPool('heal');
			const collection = EventCollection.get(pool);
			await eventStore.appendEvents(newStream(), events.slice(0, 4), { expectedVersion: 0, pool });
			await catalog().updateOne({ _id: collection }, { $set: { lastPosition: Long.fromNumber(1) } });

			await eventStore.ensureCollection(pool);

			expect(await catalog().findOne({ _id: collection })).toMatchObject({ lastPosition: 4 });
			const [envelope] = await eventStore.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool });
			expect(envelope.metadata.globalPosition).toBe(5n);
		});

		it('finishes a creation that stopped before the registration', async () => {
			const pool = reservePool('crashed');
			const collection = EventCollection.get(pool);
			await database.createCollection(collection, {
				validator: {
					$jsonSchema: {
						bsonType: 'object',
						required: ['globalPosition', 'streamId', 'version'],
						properties: { globalPosition: { bsonType: 'long' } },
					},
				},
			});

			await expect(eventStore.ensureCollection(pool)).resolves.toBe(collection);

			expect((await rawCollection(database, collection).indexes()).map(({ key }) => key)).toContainEqual({
				globalPosition: 1,
			});
			expect(await catalog().findOne({ _id: collection })).toMatchObject({ kind: 'events', schemaVersion: 2 });
		});

		it('rejects a 3.x collection, and one whose migration did not finish, without touching them', async () => {
			const v1 = reservePool('v1');
			await rawCollection(database, EventCollection.get(v1)).createIndexes([...V1_EVENT_INDEXES]);
			await rawCollection(database, EventCollection.get(v1)).insertOne(v1EventDocument(newStream(), 1));
			await expectRejectionOfClass(eventStore.ensureCollection(v1), EventStoreSchemaException, {
				collection: EventCollection.get(v1),
				found: 'v1',
				remedy: expect.stringContaining('MongoDBEventStore.migrate(config, { dryRun: true })'),
			});

			const partial = reservePool('v1-partial');
			await rawCollection(database, EventCollection.get(partial)).insertOne(v1EventDocument(newStream(), 1));
			await database.command({
				collMod: EventCollection.get(partial),
				validator: {
					$jsonSchema: {
						bsonType: 'object',
						required: ['globalPosition', 'streamId', 'version'],
						properties: { globalPosition: { bsonType: 'long' } },
					},
				},
			});
			await expectRejectionOfClass(eventStore.ensureCollection(partial), EventStoreSchemaException, {
				found: 'v1-partial',
			});

			expect(
				await catalog().countDocuments({ _id: { $in: [EventCollection.get(v1), EventCollection.get(partial)] } }),
			).toBe(0);
			expect(await rawCollection(database, EventCollection.get(v1)).countDocuments()).toBe(1);
		});

		it("with ddl: 'none', only checks and registers: a missing collection names the statements that create it", async () => {
			const { store } = createEventStore({ url, ddl: 'none' }, eventMap);
			await store.connect();
			try {
				const missing = reservePool('ddl-none');
				const error = await expectRejectionOfClass(store.ensureCollection(missing), EventStoreSchemaException, {
					collection: EventCollection.get(missing),
					found: 'missing',
				});
				expect(error.remedy).toContain(`db.createCollection('${EventCollection.get(missing)}'`);
				expect(error.remedy).toContain('createIndexes');
				expect(await database.listCollections({ name: EventCollection.get(missing) }).toArray()).toEqual([]);

				// A collection a DBA created from those statements (here: another store) is registered
				const created = await newPool('ddl-none-created');
				await catalog().deleteOne({ _id: EventCollection.get(created) });
				await expect(store.ensureCollection(created)).resolves.toBe(EventCollection.get(created));
				expect(await catalog().findOne({ _id: EventCollection.get(created) })).toMatchObject({ schemaVersion: 2 });
			} finally {
				await store.disconnect();
			}
		});

		it("with ddl: 'none' and no catalog, names the statement that creates the catalog too", async () => {
			const databaseName = `es_mgo_nocatalog_${randomBytes(4).toString('hex')}`;
			const { store } = createEventStore({ url: withDatabase(url, databaseName), ddl: 'none' }, eventMap);
			await store.connect();
			try {
				const error = await expectRejectionOfClass(store.ensureCollection(), EventStoreSchemaException, {
					found: 'missing',
				});
				expect(error.remedy).toContain(`db.createCollection('${CATALOG}')`);
			} finally {
				await store['client']?.db(databaseName).dropDatabase();
				await store.disconnect();
			}
		});

		it('wraps a failure in an EventStoreCollectionCreationException', async () => {
			const pool = reservePool('failing');
			const cause = new Error('listCollections failed');
			vi.spyOn(database, 'listCollections').mockImplementationOnce(() => {
				throw cause;
			});

			await expectRejectionOfClass(eventStore.ensureCollection(pool), EventStoreCollectionCreationException, {
				collection: EventCollection.get(pool),
				cause,
			});
		});
	});

	it('lists the event collections the catalog registers, and no other', async () => {
		const pool = await newPool('listed');
		const legacy = reservePool('listed-v1');
		await rawCollection(database, EventCollection.get(legacy)).insertOne(v1EventDocument(newStream(), 1));
		await catalog().insertOne({ _id: `lock:migrate:${EventCollection.get(legacy)}`, kind: 'lock' });

		const listed = await drain(eventStore.listCollections({ batch: 2 }));

		expect(listed).toContain(EventCollection.get(pool));
		expect(listed).not.toContain(EventCollection.get(legacy));
		expect(listed.every((collection) => !collection.startsWith('lock:'))).toBe(true);
		expect(listed).toEqual([...listed].sort());
	});

	describe('connecting', () => {
		it('disconnects once, and not at all before it connected', async () => {
			const { store } = createEventStore({ url }, eventMap);
			await expect(store.disconnect()).resolves.toBeUndefined();

			await store.connect();
			const close = vi.spyOn(store['client'] as MongoClient, 'close');
			await store.disconnect();
			await store.disconnect();
			expect(close).toHaveBeenCalledTimes(1);
			await expect(store.migrate()).rejects.toThrow('not connected');
		});

		it('closes the client when the topology check fails', async () => {
			const cause = new Error('hello failed');
			const close = vi.spyOn(MongoClient.prototype, 'close');
			vi.spyOn(MongoClient.prototype, 'db').mockImplementationOnce(() => {
				throw cause;
			});
			const { store } = createEventStore({ url }, eventMap);

			await expect(store.connect()).rejects.toBe(cause);
			expect(close).toHaveBeenCalledTimes(1);
			await expect(store.disconnect()).resolves.toBeUndefined();
		});
	});

	describe.each([
		['useBigInt64', { useBigInt64: true }],
		['promoteLongs: false', { promoteLongs: false }],
	])('with %s', (_, options) => {
		it('reads positions as bigints and versions as numbers', async () => {
			const { store } = createEventStore({ url, ...options }, eventMap);
			await store.connect();
			try {
				const pool = await newPool('bigint', store);
				const stream = newStream();
				await store.appendEvents(stream, events.slice(0, 2), { expectedVersion: 0, pool });
				const [appended] = await store.appendEvents(stream, events.slice(2, 3), { expectedVersion: 2, pool });

				expect(appended.metadata.globalPosition).toBe(3n);
				await expect(store.getStreamVersion(stream, pool)).resolves.toBe(3);
				const read = await drain(store.readAll({ pool, fromPosition: 2n }));
				expect(read.map(({ metadata }) => [metadata.version, metadata.globalPosition])).toEqual([
					[2, 2n],
					[3, 3n],
				]);
				await expect(drain(store.getEvents(stream, { pool }))).resolves.toEqual(events.slice(0, 3));
			} finally {
				await store.disconnect();
			}
		});
	});
});
