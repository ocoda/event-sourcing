import { randomBytes } from 'node:crypto';
import {
	EventCollection,
	EventCollectionNotFoundException,
	type EventEnvelope,
	EventSourcingErrorCode,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	EventStream,
	type IEventPool,
	UnregisteredEventException,
	isEventSourcingError,
} from '@ocoda/event-sourcing';
import { MongoDBEventStore } from '@ocoda/event-sourcing-mongodb';
import {
	Account,
	AccountId,
	getAccountEventEnvelopes,
	getEventMap,
	getEvents,
	mongodbTestTopologies,
} from '@ocoda/event-sourcing-testing/unit';
import { AbstractCursor, ClientSession, Collection, type Db, Long, type MongoClient, MongoServerError } from 'mongodb';
import { APPEND_LIMITS } from '../../lib/mongodb.utils.js';
import { drain, expectRejectionOfClass } from '../support/assertions.js';
import { CATALOG, dropCollections } from '../support/catalog.js';
import { createEventStore } from '../support/stores.js';

// Pool exhaustion and concurrency scenarios: allow slow tests and setup/teardown hooks.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const uniquePool = (name: string): IEventPool => `mongofix-${name}-${randomBytes(4).toString('hex')}`;

/** A server error with the labels the driver adds, like a write conflict inside a transaction. */
const labelledError = (message: string, labels: string[], code = 112) => {
	const error = new MongoServerError({ message, errmsg: message, code, errorLabels: labels });
	for (const label of labels) {
		error.addErrorLabel(label);
	}
	return error;
};

describe.each(mongodbTestTopologies())(`${MongoDBEventStore.name} resilience ($name)`, ({ name, url }) => {
	const eventMap = getEventMap();
	const events = getEvents();
	const credited = events[1];
	const replicaSet = name === 'replica-set';

	let eventStore: MongoDBEventStore;
	let client: MongoClient;
	let database: Db;
	const pools: IEventPool[] = [];

	const newStore = async () => {
		const { store } = createEventStore({ url }, eventMap);
		await store.connect();
		return store;
	};

	const newPool = async (label: string, store: MongoDBEventStore = eventStore): Promise<IEventPool> => {
		const eventPool = uniquePool(label);
		pools.push(eventPool);
		await store.ensureCollection(eventPool);
		return eventPool;
	};

	const newStream = () => EventStream.for(Account, AccountId.generate());
	const eventsOf = (eventPool: IEventPool) => database.collection(EventCollection.get(eventPool));
	const catalog = () => database.collection<{ _id: string; lastPosition?: unknown }>(CATALOG);
	const positionsOf = (envelopes: readonly EventEnvelope[]) => envelopes.map(({ metadata }) => metadata.globalPosition);

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
			Array.from({ length: count }, () => credited),
			{ expectedVersion: 0, pool: eventPool },
		);
		return stream;
	};

	beforeAll(async () => {
		eventStore = await newStore();
		client = eventStore['client'] as MongoClient;
		database = eventStore['database'];
	});

	afterAll(async () => {
		await dropCollections(
			database,
			pools.map((eventPool) => EventCollection.get(eventPool)),
		);
		await eventStore.disconnect();
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
		});

		it('should keep no cursor open between the batches of readAll', async () => {
			const eventPool = await newPool('read-all');
			await seedStream(eventPool);

			let batches = 0;
			for await (const batch of eventStore.readAll({ pool: eventPool, batch: 50 })) {
				expect(batch).toHaveLength(50);
				expect(await openCursors(eventPool)).toBe(0);
				if (++batches === 3) break;
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
			await eventsOf(eventPool).updateOne(
				{ streamId: stream.streamId, version: 150 },
				{ $set: { event: 'event-that-was-never-registered' } },
			);

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
		it('should not look the collection up in the catalog on appends, nor on reads that find events', async () => {
			const eventPool = await newPool('known');
			const otherStore = await newStore();
			try {
				const findOne = vi.spyOn(Collection.prototype, 'findOne');

				const stream = newStream();
				await otherStore.appendEvents(stream, events.slice(0, 2), { expectedVersion: 0, pool: eventPool });
				await otherStore.appendEvents(stream, events.slice(2, 4), { expectedVersion: 2, pool: eventPool });
				await drain(otherStore.readAll({ pool: eventPool }));

				// Only the first read that finds nothing (the version of the new stream) asks the catalog
				expect(findOne).toHaveBeenCalledTimes(1);
			} finally {
				await otherStore.disconnect();
			}
		});

		it("should report a 'not-persisted' outcome when the version check fails", async () => {
			const eventPool = await newPool('check-fails');
			const cause = new Error('connection reset');
			vi.spyOn(AbstractCursor.prototype, 'toArray').mockRejectedValueOnce(cause);

			await expectRejectionOfClass(
				eventStore.appendEvents(newStream(), events.slice(0, 2), { expectedVersion: 0, pool: eventPool }),
				EventStorePersistenceException,
				{ code: EventSourcingErrorCode.EventStorePersistence, outcome: 'not-persisted', cause },
			);
		});

		it("should report a 'not-persisted' outcome, and store nothing, when the insert fails", async () => {
			const eventPool = await newPool('insert-fails');
			const [before] = await eventStore.appendEvents(newStream(), events.slice(0, 1), {
				expectedVersion: 0,
				pool: eventPool,
			});
			const cause = new Error('insert failed');
			const insertMany = Collection.prototype.insertMany;
			// The first event is stored before the insert fails (the standalone insert is ordered, not atomic)
			vi.spyOn(Collection.prototype, 'insertMany').mockImplementationOnce(async function (
				this: Collection,
				documents,
				options,
			) {
				await insertMany.call(this, documents.slice(0, 1), options);
				throw cause;
			});

			const stream = newStream();
			await expectRejectionOfClass(
				eventStore.appendEvents(stream, events.slice(0, 3), { expectedVersion: 0, pool: eventPool }),
				EventStorePersistenceException,
				{ outcome: 'not-persisted', cause },
			);

			expect(await eventsOf(eventPool).countDocuments({ streamId: stream.streamId })).toBe(0);
			const next = await eventStore.appendEvents(stream, events.slice(0, 1), { expectedVersion: 0, pool: eventPool });
			// A replica set rolls the counter back with the transaction; a standalone server burns the reserved positions
			expect(positionsOf(next)).toEqual([replicaSet ? 2n : 5n]);
			expect(positionsOf(await drain(eventStore.readAll({ pool: eventPool })))).toEqual([
				before.metadata.globalPosition,
				...positionsOf(next),
			]);
		});

		it('should reject an append whose pool lost its catalog document, without writing', async () => {
			const eventPool = await newPool('unregistered-append');
			await catalog().deleteOne({ _id: EventCollection.get(eventPool) });
			const otherStore = await newStore();
			try {
				const error = await expectRejectionOfClass(
					otherStore.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: eventPool }),
					EventStorePersistenceException,
					{ outcome: 'not-persisted' },
				);
				expect(isEventSourcingError(error.cause, EventSourcingErrorCode.EventCollectionNotFound)).toBe(true);
				expect(error.cause).toBeInstanceOf(EventCollectionNotFoundException);
				expect(await eventsOf(eventPool).countDocuments()).toBe(0);
			} finally {
				await otherStore.disconnect();
			}
		});

		it("should report a 'not-persisted' outcome for an event id that another stream holds", async () => {
			const eventPool = await newPool('duplicate-id');
			const [taken] = await eventStore.appendEvents(newStream(), events.slice(0, 1), {
				expectedVersion: 0,
				pool: eventPool,
			});
			const stream = newStream();
			const [envelope] = getAccountEventEnvelopes(AccountId.from(stream.aggregateId), eventMap, events);
			Object.assign(envelope.metadata, { eventId: taken.metadata.eventId });

			const error = await expectRejectionOfClass(
				eventStore.appendEvents(stream, [envelope], { expectedVersion: 0, pool: eventPool }),
				EventStorePersistenceException,
				{ outcome: 'not-persisted' },
			);
			expect(error.cause).toMatchObject({ message: expect.stringContaining('event id'), cause: { code: 11000 } });
			expect(await eventsOf(eventPool).countDocuments({ streamId: stream.streamId })).toBe(0);
		});

		it('should report a conflict when the same append was stored after its version check', async () => {
			const eventPool = await newPool('retried');
			const stream = newStream();
			const envelopes = getAccountEventEnvelopes(AccountId.from(stream.aggregateId), eventMap, events).slice(0, 2);
			await eventStore.appendEvents(stream, envelopes, { expectedVersion: 0, pool: eventPool });

			// The version check still read the stream before the first attempt was stored
			vi.spyOn(MongoDBEventStore.prototype, 'getStreamVersion').mockResolvedValueOnce(0);
			await expectRejectionOfClass(
				eventStore.appendEvents(stream, envelopes, { expectedVersion: 0, pool: eventPool }),
				EventStoreVersionConflictException,
				{ expectedVersion: 0, actualVersion: 2, cause: expect.objectContaining({ code: 11000 }) },
			);
		});

		it("should report a 'not-persisted' outcome on position drift, which ensureCollection heals", async () => {
			const eventPool = await newPool('drift');
			const collection = EventCollection.get(eventPool);
			const stored = await eventStore.appendEvents(newStream(), events.slice(0, 3), {
				expectedVersion: 0,
				pool: eventPool,
			});
			await catalog().updateOne({ _id: collection }, { $set: { lastPosition: Long.fromNumber(1) } });
			const logged = vi.spyOn(eventStore['logger'], 'error').mockImplementation(() => undefined);

			const stream = newStream();
			const error = await expectRejectionOfClass(
				eventStore.appendEvents(stream, events.slice(0, 1), { expectedVersion: 0, pool: eventPool }),
				EventStorePersistenceException,
				{ outcome: 'not-persisted' },
			);
			expect(error.cause).toMatchObject({ code: 11000 });
			expect(logged).toHaveBeenCalledWith(expect.stringContaining('position drift'));
			// The events at the positions the drifted counter handed out again are untouched
			expect(await drain(eventStore.readAll({ pool: eventPool }))).toEqual(stored);

			await eventStore.ensureCollection(eventPool);
			const [healed] = await eventStore.appendEvents(stream, events.slice(0, 1), {
				expectedVersion: 0,
				pool: eventPool,
			});
			expect(healed.metadata.globalPosition).toBe(4n);
		});

		describe.runIf(!replicaSet)('on a standalone server', () => {
			it("should report an 'unknown' outcome when the events of a failed insert can't be removed", async () => {
				const eventPool = await newPool('cleanup-fails');
				const stream = newStream();
				const insertMany = Collection.prototype.insertMany;
				vi.spyOn(Collection.prototype, 'insertMany').mockImplementationOnce(async function (
					this: Collection,
					documents,
					options,
				) {
					await insertMany.call(this, documents.slice(0, 1), options);
					throw new Error('insert failed');
				});
				const cleanupError = new Error('cleanup failure');
				vi.spyOn(Collection.prototype, 'deleteMany').mockRejectedValueOnce(cleanupError);

				const error = await expectRejectionOfClass(
					eventStore.appendEvents(stream, events.slice(0, 2), { expectedVersion: 0, pool: eventPool }),
					EventStorePersistenceException,
					{ outcome: 'unknown', cause: expect.any(AggregateError) },
				);
				expect((error.cause as AggregateError).errors).toEqual([
					expect.objectContaining({ message: 'insert failed' }),
					cleanupError,
				]);
				expect(await eventsOf(eventPool).countDocuments({ streamId: stream.streamId })).toBe(1);
			});

			it("should report a 'not-persisted' outcome when reserving the positions fails", async () => {
				const eventPool = await newPool('reserve-fails');
				const cause = new Error('counter unavailable');
				vi.spyOn(Collection.prototype, 'findOneAndUpdate').mockRejectedValueOnce(cause);

				await expectRejectionOfClass(
					eventStore.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: eventPool }),
					EventStorePersistenceException,
					{ outcome: 'not-persisted', cause },
				);
			});

			it('should let one writer win a race after the version check, and take back what the others stored', async () => {
				const WRITERS = 8;
				const eventPool = await newPool('race');
				const stream = newStream();
				const accountId = AccountId.from(stream.aggregateId);

				// Hold every writer right before its insert, so after its version check, until all of them got there
				let waiting = 0;
				let releaseWriters: () => void = () => undefined;
				const allChecked = new Promise<void>((resolve) => {
					releaseWriters = resolve;
				});
				const insertMany = Collection.prototype.insertMany;
				vi.spyOn(Collection.prototype, 'insertMany').mockImplementation(async function (
					this: Collection,
					...args: Parameters<Collection['insertMany']>
				) {
					if (++waiting === WRITERS) {
						releaseWriters();
					}
					await allChecked;
					return insertMany.apply(this, args);
				});

				const results = await Promise.allSettled(
					Array.from({ length: WRITERS }, () =>
						eventStore.appendEvents(stream, getAccountEventEnvelopes(accountId, eventMap, events), {
							expectedVersion: 0,
							pool: eventPool,
						}),
					),
				);

				expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
				for (const result of results.filter(
					(result): result is PromiseRejectedResult => result.status === 'rejected',
				)) {
					expect(result.reason).toBeInstanceOf(EventStoreVersionConflictException);
					expect(result.reason).toMatchObject({ expectedVersion: 0, actualVersion: events.length, pool: eventPool });
				}
				const stored = await eventsOf(eventPool).find({ streamId: stream.streamId }).sort({ version: 1 }).toArray();
				expect(stored.map(({ version }) => version)).toEqual(events.map((_, index) => index + 1));
				// Every writer reserved its block of positions; the losers' blocks are holes that never fill
				expect(await catalog().findOne({ _id: EventCollection.get(eventPool) })).toMatchObject({
					lastPosition: WRITERS * events.length,
				});
			});
		});

		describe.runIf(replicaSet)('on a replica set', () => {
			it('should retry a transient transaction error with the same positions', async () => {
				const eventPool = await newPool('transient');
				const insertMany = vi
					.spyOn(Collection.prototype, 'insertMany')
					.mockRejectedValueOnce(labelledError('WriteConflict', ['TransientTransactionError']));

				const appended = await eventStore.appendEvents(newStream(), events.slice(0, 2), {
					expectedVersion: 0,
					pool: eventPool,
				});

				expect(insertMany).toHaveBeenCalledTimes(2);
				expect(positionsOf(appended)).toEqual([1n, 2n]);
			});

			it("should report a 'not-persisted' outcome once transient errors outlast the budget", async () => {
				const eventPool = await newPool('budget');
				const transient = labelledError('WriteConflict', ['TransientTransactionError']);
				const insertMany = vi.spyOn(Collection.prototype, 'insertMany').mockRejectedValue(transient);
				APPEND_LIMITS.transactionBudgetMs = 50;
				onTestFinished(() => {
					APPEND_LIMITS.transactionBudgetMs = 30_000;
				});

				await expectRejectionOfClass(
					eventStore.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: eventPool }),
					EventStorePersistenceException,
					{ outcome: 'not-persisted', cause: transient },
				);
				expect(insertMany.mock.calls.length).toBeGreaterThan(1);
				expect(await catalog().findOne({ _id: EventCollection.get(eventPool) })).toMatchObject({ lastPosition: 0 });
			});

			it('should retry a commit whose result is unknown', async () => {
				const eventPool = await newPool('commit-retry');
				const commitTransaction = ClientSession.prototype.commitTransaction;
				const commit = vi.spyOn(ClientSession.prototype, 'commitTransaction').mockImplementationOnce(async function (
					this: ClientSession,
				) {
					// The commit happens, the answer is lost
					await commitTransaction.call(this);
					throw labelledError('connection lost', ['UnknownTransactionCommitResult'], 6);
				});

				const appended = await eventStore.appendEvents(newStream(), events.slice(0, 2), {
					expectedVersion: 0,
					pool: eventPool,
				});

				expect(commit).toHaveBeenCalledTimes(2);
				expect(positionsOf(appended)).toEqual([1n, 2n]);
				expect(await eventsOf(eventPool).countDocuments()).toBe(2);
			});

			it("should report an 'unknown' outcome when the commit result stays unknown, or the commit fails", async () => {
				const eventPool = await newPool('commit-unknown');
				const unknown = labelledError('connection lost', ['UnknownTransactionCommitResult'], 6);
				vi.spyOn(ClientSession.prototype, 'commitTransaction').mockRejectedValue(unknown);

				await expectRejectionOfClass(
					eventStore.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: eventPool }),
					EventStorePersistenceException,
					{ outcome: 'unknown', cause: unknown },
				);
				expect(ClientSession.prototype.commitTransaction).toHaveBeenCalledTimes(4);

				vi.restoreAllMocks();
				const failed = new Error('commit failed');
				vi.spyOn(ClientSession.prototype, 'commitTransaction').mockRejectedValueOnce(failed);
				await expectRejectionOfClass(
					eventStore.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: eventPool }),
					EventStorePersistenceException,
					{ outcome: 'unknown', cause: failed },
				);
			});
		});
	});
});
