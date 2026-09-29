import { randomBytes } from 'node:crypto';
import {
	EventCollection,
	type EventEnvelope,
	EventStorePersistenceException,
	EventSourcingErrorCode,
	EventStoreVersionConflictException,
	EventStream,
	type IEventPool,
	UnregisteredEventException,
} from '@ocoda/event-sourcing';
import { type MongoDBEventEntity, MongoDBEventStore } from '@ocoda/event-sourcing-mongodb';
import {
	Account,
	AccountId,
	getAccountEventEnvelopes,
	getEventMap,
	getEvents,
} from '@ocoda/event-sourcing-testing/unit';
import { AbstractCursor, Collection, type Db, type MongoClient } from 'mongodb';

// Pool exhaustion and concurrency scenarios: allow slow tests and setup/teardown hooks.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

type Config = ConstructorParameters<typeof MongoDBEventStore>[1];

const config = () => ({ url: 'mongodb://localhost:27017' }) as unknown as Config;

const uniquePool = (name: string): IEventPool => `mongofix-${name}-${randomBytes(4).toString('hex')}`;

describe(`${MongoDBEventStore.name} resilience`, () => {
	const eventMap = getEventMap();
	const events = getEvents();
	const credited = events[1];

	let eventStore: MongoDBEventStore;
	let client: MongoClient;
	let database: Db;
	const pools: IEventPool[] = [];

	const newStore = async () => {
		const store = new MongoDBEventStore(eventMap, config());
		store.publish = vi.fn(async () => Promise.resolve());
		await store.connect();
		return store;
	};

	const newPool = async (name: string, store: MongoDBEventStore = eventStore): Promise<IEventPool> => {
		const eventPool = uniquePool(name);
		pools.push(eventPool);
		await store.ensureCollection(eventPool);
		return eventPool;
	};

	const newStream = () => EventStream.for(Account, AccountId.generate());

	/** The number of cursors that are open on the server for a collection. */
	const openCursors = async (eventPool: IEventPool): Promise<number> => {
		const cursors = await client
			.db('admin')
			.aggregate([
				{ $currentOp: { allUsers: true, idleCursors: true } },
				{ $match: { type: 'idleCursor', ns: `${database.databaseName}.${EventCollection.get(eventPool)}` } },
			])
			.toArray();
		return cursors.length;
	};

	/** Seeds a stream with more events than fit in the first batch of a server cursor (101). */
	const seedStream = async (eventPool: IEventPool, count = 300) => {
		const stream = newStream();
		await eventStore.appendEvents(
			stream,
			count,
			Array.from({ length: count }, () => credited),
			eventPool,
		);
		return stream;
	};

	beforeAll(async () => {
		eventStore = await newStore();

		client = eventStore['client'];
		database = eventStore['database'];
	});

	afterAll(async () => {
		await Promise.all(
			pools.map((eventPool) =>
				database
					.collection(EventCollection.get(eventPool))
					.drop()
					.catch(() => undefined),
			),
		);
		await eventStore.disconnect();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('reading', () => {
		it('should close the cursor when the consumer stops reading early', async () => {
			const eventPool = await newPool('early-exit');
			const stream = await seedStream(eventPool);

			for await (const batch of eventStore.getEvents(stream, { pool: eventPool, batch: 1 })) {
				expect(batch).toHaveLength(1);
				// the cursor is open while the consumer is reading...
				expect(await openCursors(eventPool)).toBe(1);
				break;
			}
			// ...and closed as soon as it stops
			expect(await openCursors(eventPool)).toBe(0);

			for await (const batch of eventStore.getEnvelopes(stream, { pool: eventPool, batch: 1 })) {
				expect(batch).toHaveLength(1);
				expect(await openCursors(eventPool)).toBe(1);
				break;
			}
			expect(await openCursors(eventPool)).toBe(0);

			for await (const batch of eventStore.getAllEnvelopes({
				since: { year: 2000, month: 1 },
				pool: eventPool,
				batch: 1,
			})) {
				expect(batch).toHaveLength(1);
				expect(await openCursors(eventPool)).toBe(1);
				break;
			}
			expect(await openCursors(eventPool)).toBe(0);
		});

		it('should close the cursor of the collections listing when the consumer stops reading early', async () => {
			await newPool('listing-a');
			await newPool('listing-b');
			const close = vi.spyOn(AbstractCursor.prototype, 'close');

			for await (const batch of eventStore.listCollections({ batch: 1 })) {
				expect(batch).toHaveLength(1);
				break;
			}

			expect(close).toHaveBeenCalled();
		});

		it('should close the cursor when the consumer throws while reading', async () => {
			const eventPool = await newPool('consumer-throws');
			const stream = await seedStream(eventPool);

			await expect(async () => {
				for await (const _ of eventStore.getEnvelopes(stream, { pool: eventPool, batch: 1 })) {
					expect(await openCursors(eventPool)).toBe(1);
					throw new Error('consumer failure');
				}
			}).rejects.toThrow('consumer failure');

			expect(await openCursors(eventPool)).toBe(0);
		});

		it('should close the cursor when an event of the stream is not registered', async () => {
			const eventPool = await newPool('unregistered');
			const stream = await seedStream(eventPool, 200);
			// corrupt an event that is not part of the first batch of the cursor
			await database
				.collection<MongoDBEventEntity>(EventCollection.get(eventPool))
				.updateOne({ streamId: stream.streamId, version: 150 }, { $set: { event: 'event-that-was-never-registered' } });

			const resolved: unknown[] = [];
			await expect(async () => {
				for await (const batch of eventStore.getEvents(stream, { pool: eventPool, batch: 50 })) {
					resolved.push(...batch);
				}
			}).rejects.toThrow(UnregisteredEventException);

			expect(resolved).toHaveLength(100);
			expect(await openCursors(eventPool)).toBe(0);
		});

		it('should not reuse the yielded batches', async () => {
			const eventPool = await newPool('batches');
			const stream = await seedStream(eventPool, 250);

			const batches: unknown[][] = [];
			for await (const batch of eventStore.getEvents(stream, { pool: eventPool, batch: 100 })) {
				batches.push(batch);
			}

			expect(batches.map(({ length }) => length)).toEqual([100, 100, 50]);
		});
	});

	describe('appending', () => {
		describe('to known collections', () => {
			it('should not look up the collection again on every append', async () => {
				const eventPool = await newPool('known');
				const listCollections = vi.spyOn(database, 'listCollections');

				const stream = newStream();
				await eventStore.appendEvents(stream, 2, events.slice(0, 2), eventPool);
				await eventStore.appendEvents(stream, 4, events.slice(2, 4), eventPool);
				await eventStore.appendEvents(stream, 6, events.slice(4, 6), eventPool);

				expect(listCollections).not.toHaveBeenCalled();
			});

			it('should look up a collection that was created elsewhere only once', async () => {
				const eventPool = await newPool('elsewhere');
				const otherStore = await newStore();

				try {
					const listCollections = vi.spyOn(otherStore['database'], 'listCollections');

					const stream = newStream();
					await otherStore.appendEvents(stream, 2, events.slice(0, 2), eventPool);
					await otherStore.appendEvents(stream, 4, events.slice(2, 4), eventPool);
					await otherStore.appendEvents(stream, 6, events.slice(4, 6), eventPool);

					expect(listCollections).toHaveBeenCalledTimes(1);
				} finally {
					await otherStore.disconnect();
				}
			});
		});

		describe('to unknown collections', () => {
			it('should keep rejecting them and check the server each time', async () => {
				const eventPool = uniquePool('unknown');
				pools.push(eventPool);
				const listCollections = vi.spyOn(database, 'listCollections');

				await expect(eventStore.appendEvents(newStream(), 1, events.slice(0, 1), eventPool)).rejects.toThrow(
					EventStorePersistenceException,
				);
				await expect(eventStore.appendEvents(newStream(), 1, events.slice(0, 1), eventPool)).rejects.toThrow(
					EventStorePersistenceException,
				);
				expect(listCollections).toHaveBeenCalledTimes(2);

				// once the collection exists, it is picked up
				const otherStore = await newStore();
				try {
					await otherStore.ensureCollection(eventPool);
				} finally {
					await otherStore.disconnect();
				}
				await expect(eventStore.appendEvents(newStream(), 1, events.slice(0, 1), eventPool)).resolves.toHaveLength(1);
			});
		});

		describe('concurrent writers', () => {
			const WRITERS = 8;

			const settle = (store: MongoDBEventStore, stream: EventStream, eventPool: IEventPool) =>
				Promise.allSettled(
					Array.from({ length: WRITERS }, () =>
						store.appendEvents(
							stream,
							events.length,
							getAccountEventEnvelopes(AccountId.from(stream.aggregateId), eventMap, events),
							eventPool,
						),
					),
				);

			const expectExactlyOneWinner = async (
				results: PromiseSettledResult<EventEnvelope[]>[],
				stream: EventStream,
				eventPool: IEventPool,
			) => {
				const fulfilled = results.filter(({ status }) => status === 'fulfilled');
				const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

				expect(fulfilled).toHaveLength(1);
				expect(rejected).toHaveLength(WRITERS - 1);
				for (const { reason } of rejected) {
					expect(reason).toBeInstanceOf(EventStoreVersionConflictException);
					expect(reason).toMatchObject({
						code: EventSourcingErrorCode.EventStoreVersionConflict,
						streamId: stream.streamId,
						aggregateId: stream.aggregateId,
						pool: eventPool,
						expectedVersion: 0,
						actualVersion: events.length,
					});
				}

				const entities = await database
					.collection<MongoDBEventEntity>(EventCollection.get(eventPool))
					.find({ streamId: stream.streamId })
					.sort({ version: 1 })
					.toArray();
				expect(entities.map(({ version }) => version)).toEqual(events.map((_, index) => index + 1));
			};

			it('should let exactly one writer win and report a version conflict to the others', async () => {
				const eventPool = await newPool('concurrent');
				for (let round = 0; round < 5; round++) {
					const stream = newStream();
					await expectExactlyOneWinner(await settle(eventStore, stream, eventPool), stream, eventPool);
				}
			});

			it('should report a version conflict when the race is lost after the version check passed', async () => {
				const eventPool = await newPool('concurrent-check');
				const stream = newStream();

				// Hold every writer right before its insert, so after its version check, until all of them got there.
				// None of them can then be stopped by the check and the unique index has to decide.
				let waiting = 0;
				let releaseWriters: () => void;
				const allChecked = new Promise<void>((resolve) => {
					releaseWriters = resolve;
				});
				const insertMany = Collection.prototype.insertMany;
				const insertManySpy = vi.spyOn(Collection.prototype, 'insertMany').mockImplementation(async function (
					this: Collection,
					...args: Parameters<Collection['insertMany']>
				) {
					if (++waiting === WRITERS) {
						releaseWriters();
					}
					await allChecked;
					return insertMany.apply(this, args);
				});

				await expectExactlyOneWinner(await settle(eventStore, stream, eventPool), stream, eventPool);
				expect(insertManySpy).toHaveBeenCalledTimes(WRITERS);
			});

			it('should not leave a part of the events behind when the race is lost halfway', async () => {
				const eventPool = await newPool('partial');
				const stream = newStream();
				const accountId = AccountId.from(stream.aggregateId);
				const [first, second, third, fourth, fifth, sixth] = getAccountEventEnvelopes(accountId, eventMap, events);
				await eventStore.appendEvents(stream, 3, [first, second, third], eventPool);

				// A concurrent writer stores version 5 after this writer checked the version, but before it inserts.
				const raced = getAccountEventEnvelopes(accountId, eventMap, events)[4];
				const collection = database.collection<MongoDBEventEntity>(EventCollection.get(eventPool));
				const insertMany = Collection.prototype.insertMany;
				vi.spyOn(Collection.prototype, 'insertMany').mockImplementationOnce(async function (
					this: Collection,
					...args: Parameters<Collection['insertMany']>
				) {
					await collection.insertOne({
						_id: raced.metadata.eventId.value,
						streamId: stream.streamId,
						event: raced.event,
						payload: raced.payload,
						eventDate: raced.metadata.eventId.yearMonth,
						aggregateId: raced.metadata.aggregateId,
						version: raced.metadata.version,
						occurredOn: raced.metadata.occurredOn,
					});
					return insertMany.apply(this, args);
				});

				await expect(eventStore.appendEvents(stream, 6, [fourth, fifth, sixth], eventPool)).rejects.toBeInstanceOf(
					EventStoreVersionConflictException,
				);

				// Version 4 of the losing writer was inserted before the conflict at version 5, it is taken back
				const entities = await collection.find({ streamId: stream.streamId }).sort({ version: 1 }).toArray();
				expect(entities.map(({ version }) => version)).toEqual([1, 2, 3, 5]);
				expect(entities.map(({ _id }) => _id)).not.toContain(fourth.metadata.eventId.value);
			});
		});
	});
});
