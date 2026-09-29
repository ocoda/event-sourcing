import {
	EventCollection,
	type EventEnvelope,
	EventNotFoundException,
	EventStoreCollectionCreationException,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	EventStream,
	type IEvent,
	type IEventCollection,
	StreamReadingDirection,
	UnregisteredEventException,
} from '@ocoda/event-sourcing';
import { type PostgresEventEntity, PostgresEventStore } from '@ocoda/event-sourcing-postgres';
import {
	Account,
	AccountId,
	eventStreamAccountA,
	eventStreamAccountB,
	getAccountAEventEnvelopes,
	getAccountBEventEnvelopes,
	getAccountEventEnvelopes,
	getEventMap,
	getEvents,
} from '@ocoda/event-sourcing-testing/unit';
import { Client, type Pool, escapeIdentifier } from 'pg';

const connectionOptions = {
	host: '127.0.0.1',
	port: 5432,
	user: 'postgres',
	password: 'postgres',
	database: 'postgres',
	application_name: 'postgres-event-store-spec',
};

describe(PostgresEventStore, () => {
	let eventStore: PostgresEventStore;
	let envelopesAccountA: EventEnvelope[];
	let envelopesAccountB: EventEnvelope[];
	const publish = jest.fn(async () => Promise.resolve());

	let pool: Pool;

	const eventMap = getEventMap();
	const events = getEvents();

	beforeAll(async () => {
		eventStore = new PostgresEventStore(eventMap, { driver: undefined as never, ...connectionOptions });
		eventStore.publish = publish;

		await eventStore.connect();
		await eventStore.ensureCollection();

		envelopesAccountA = getAccountAEventEnvelopes(eventMap, events);
		envelopesAccountB = getAccountBEventEnvelopes(eventMap, events);

		// biome-ignore lint/complexity/useLiteralKeys: Needed to check the internal workings of the event store
		pool = eventStore['pool'];
	});

	afterAll(async () => {
		await Promise.all([
			pool.query(`DROP TABLE IF EXISTS "${EventCollection.get()}"`),
			pool.query(`DROP TABLE IF EXISTS "${EventCollection.get('test-singular-events')}"`),
			pool.query(`DROP TABLE IF EXISTS "${EventCollection.get('a')}"`),
			pool.query(`DROP TABLE IF EXISTS "${EventCollection.get('b')}"`),
			pool.query(`DROP TABLE IF EXISTS "${EventCollection.get('c')}"`),
		]);
		await eventStore.disconnect();
	});

	it('should append event envelopes', async () => {
		await eventStore.appendEvents(eventStreamAccountA, envelopesAccountA.length, envelopesAccountA);
		await eventStore.appendEvents(eventStreamAccountB, envelopesAccountB.length, envelopesAccountB);

		const { rows: entities } = await pool.query<PostgresEventEntity>(`
			SELECT * FROM "${EventCollection.get()}" ORDER BY version ASC
		`);

		const entitiesAccountA = entities.filter(
			({ stream_id: entityStreamId }) => entityStreamId === eventStreamAccountA.streamId,
		);
		const entitiesAccountB = entities.filter(
			({ stream_id: entityStreamId }) => entityStreamId === eventStreamAccountB.streamId,
		);

		expect(entities).toHaveLength(events.length * 2);
		expect(entitiesAccountA).toHaveLength(events.length);
		expect(entitiesAccountB).toHaveLength(events.length);

		for (const [index, entity] of entitiesAccountA.entries()) {
			expect(entity.stream_id).toEqual(eventStreamAccountA.streamId);
			expect(entity.event).toEqual(envelopesAccountA[index].event);
			expect(entity.payload).toEqual(envelopesAccountA[index].payload);
			expect(entity.aggregate_id).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(typeof entity.event_id).toBe('string');
			expect(entity.occurred_on).toEqual(envelopesAccountA[index].metadata.occurredOn);
			expect(entity.version).toEqual(envelopesAccountA[index].metadata.version);
		}

		for (const [index, entity] of entitiesAccountB.entries()) {
			expect(entity.stream_id).toEqual(eventStreamAccountB.streamId);
			expect(entity.event).toEqual(envelopesAccountB[index].event);
			expect(entity.payload).toEqual(envelopesAccountB[index].payload);
			expect(entity.aggregate_id).toEqual(envelopesAccountB[index].metadata.aggregateId);
			expect(typeof entity.event_id).toBe('string');
			expect(entity.occurred_on).toEqual(envelopesAccountB[index].metadata.occurredOn);
			expect(entity.version).toEqual(envelopesAccountB[index].metadata.version);
		}

		expect(publish).toHaveBeenCalledTimes(events.length * 2);
	});

	it('should append events', async () => {
		const accountId = AccountId.generate();
		const eventStreamAccountC = EventStream.for(Account, accountId);
		const envelopesAccountC = getAccountEventEnvelopes(accountId, eventMap, events);

		await eventStore.ensureCollection('test-singular-events');
		await eventStore.appendEvents(eventStreamAccountC, envelopesAccountC.length, events, 'test-singular-events');

		const { rows: entities } = await pool.query<PostgresEventEntity>(`
			SELECT * FROM "${EventCollection.get('test-singular-events')}" ORDER BY version ASC
		`);

		for (const [index, entity] of entities.entries()) {
			expect(entity.stream_id).toEqual(eventStreamAccountC.streamId);
			expect(entity.event).toEqual(envelopesAccountC[index].event);
			expect(entity.payload).toEqual(envelopesAccountC[index].payload);
			expect(entity.aggregate_id).toEqual(envelopesAccountC[index].metadata.aggregateId);
			expect(entity.occurred_on).toBeInstanceOf(Date);
			expect(entity.version).toEqual(envelopesAccountC[index].metadata.version);
		}
	});

	it('should throw when trying to append an event to a stream that has a version lower or equal to the latest event for that stream', async () => {
		const lastEvent = events[events.length - 1];
		const lastVersion = events.length;
		const beforeLastVersion = lastVersion - 1;
		await expect(eventStore.appendEvents(eventStreamAccountA, beforeLastVersion, [lastEvent])).rejects.toThrow(
			new EventStoreVersionConflictException(eventStreamAccountA, beforeLastVersion, lastVersion),
		);
		await expect(eventStore.appendEvents(eventStreamAccountA, lastVersion, [lastEvent])).rejects.toThrow(
			new EventStoreVersionConflictException(eventStreamAccountA, lastVersion, lastVersion),
		);
	});

	it("should throw when event envelopes can't be appended", async () => {
		await expect(eventStore.appendEvents(eventStreamAccountA, 3, events.slice(0, 3), 'not-a-pool')).rejects.toThrow(
			EventStorePersistenceException,
		);
	});

	it('should retrieve a single event from a specified stream', async () => {
		const resolvedEvent = await eventStore.getEvent(eventStreamAccountA, envelopesAccountA[3].metadata.version);

		expect(resolvedEvent).toEqual(events[3]);
	});

	it('should filter events by stream', async () => {
		const resolvedEvents: IEvent[] = [];
		for await (const events of eventStore.getEvents(eventStreamAccountA)) {
			resolvedEvents.push(...events);
		}

		expect(resolvedEvents).toEqual(events);
	});

	it('should filter events by stream and version', async () => {
		const resolvedEvents: IEvent[] = [];
		for await (const events of eventStore.getEvents(eventStreamAccountA, {
			fromVersion: 3,
		})) {
			resolvedEvents.push(...events);
		}

		expect(resolvedEvents).toEqual(events.slice(2));
	});

	it("should throw when an event isn't found in a specified stream", async () => {
		const stream = EventStream.for(Account, AccountId.generate());
		await expect(eventStore.getEvent(stream, 5)).rejects.toThrow(new EventNotFoundException(stream.streamId, 5));
	});

	it('should retrieve events backwards', async () => {
		const resolvedEvents: IEvent[] = [];
		for await (const events of eventStore.getEvents(eventStreamAccountA, {
			direction: StreamReadingDirection.BACKWARD,
		})) {
			resolvedEvents.push(...events);
		}

		expect(resolvedEvents).toEqual(events.slice().reverse());
	});

	it('should retrieve events backwards from a certain version', async () => {
		const resolvedEvents: IEvent[] = [];
		for await (const events of eventStore.getEvents(eventStreamAccountA, {
			fromVersion: 4,
			direction: StreamReadingDirection.BACKWARD,
		})) {
			resolvedEvents.push(...events);
		}

		expect(resolvedEvents).toEqual(events.slice(3).reverse());
	});

	it('should limit the returned events', async () => {
		const resolvedEvents: IEvent[] = [];
		for await (const events of eventStore.getEvents(eventStreamAccountA, {
			limit: 3,
		})) {
			resolvedEvents.push(...events);
		}

		expect(resolvedEvents).toEqual(events.slice(0, 3));
	});

	it('should batch the returned events', async () => {
		const resolvedEvents: IEvent[] = [];
		for await (const events of eventStore.getEvents(eventStreamAccountA, {
			batch: 2,
		})) {
			expect(events.length).toBe(2);
			resolvedEvents.push(...events);
		}

		expect(resolvedEvents).toEqual(events);
	});

	it('should retrieve a single event-envelope', async () => {
		const { event, metadata, payload } = await eventStore.getEnvelope(
			eventStreamAccountA,
			envelopesAccountA[3].metadata.version,
		);

		expect(event).toEqual(envelopesAccountA[3].event);
		expect(payload).toEqual(envelopesAccountA[3].payload);
		expect(metadata.aggregateId).toEqual(envelopesAccountA[3].metadata.aggregateId);
		expect(metadata.occurredOn).toBeInstanceOf(Date);
		expect(metadata.version).toEqual(envelopesAccountA[3].metadata.version);
	});

	it('should retrieve event-envelopes', async () => {
		const resolvedEnvelopes: EventEnvelope[] = [];
		for await (const envelopes of eventStore.getEnvelopes(eventStreamAccountA)) {
			resolvedEnvelopes.push(...envelopes);
		}

		expect(resolvedEnvelopes).toHaveLength(envelopesAccountA.length);

		for (const [index, envelope] of resolvedEnvelopes.entries()) {
			expect(envelope.event).toEqual(envelopesAccountA[index].event);
			expect(envelope.payload).toEqual(envelopesAccountA[index].payload);
			expect(envelope.metadata.aggregateId).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(envelope.metadata.occurredOn).toBeInstanceOf(Date);
			expect(envelope.metadata.version).toEqual(envelopesAccountA[index].metadata.version);
		}
	});

	it('should retrieve all event-envelopes since a specified time', async () => {
		const seedAllEnvelopes = [...envelopesAccountA, ...envelopesAccountB].sort((a, b) =>
			a.metadata.eventId.value < b.metadata.eventId.value ? -1 : 1,
		);

		const resolvedAllEnvelopes: EventEnvelope[] = [];
		for await (const envelopes of eventStore.getAllEnvelopes({ since: { year: 2021, month: 1 } })) {
			resolvedAllEnvelopes.push(...envelopes);
		}

		expect(resolvedAllEnvelopes).toHaveLength(envelopesAccountA.length + envelopesAccountB.length);

		for (const [index, envelope] of resolvedAllEnvelopes.entries()) {
			expect(envelope.event).toEqual(seedAllEnvelopes[index].event);
			expect(envelope.payload).toEqual(seedAllEnvelopes[index].payload);
			expect(envelope.metadata.aggregateId).toEqual(seedAllEnvelopes[index].metadata.aggregateId);
			expect(envelope.metadata.eventId.value).toEqual(seedAllEnvelopes[index].metadata.eventId.value);
			expect(envelope.metadata.version).toEqual(seedAllEnvelopes[index].metadata.version);
		}
	});

	it('should retrieve all event-envelopes batched', async () => {
		const resolvedBatchedEnvelopes: EventEnvelope[] = [];
		for await (const envelopes of eventStore.getAllEnvelopes({ since: { year: 2021, month: 1 }, batch: 2 })) {
			expect(envelopes.length).toBe(2);
			resolvedBatchedEnvelopes.push(...envelopes);
		}
	});

	it('should list collections', async () => {
		await Promise.all([
			eventStore.ensureCollection('a'),
			eventStore.ensureCollection('b'),
			eventStore.ensureCollection('c'),
		]);

		const resolvedCollections: IEventCollection[] = [];
		for await (const collections of eventStore.listCollections()) {
			resolvedCollections.push(...collections);
		}

		expect(resolvedCollections.includes('a-events')).toBe(true);
		expect(resolvedCollections.includes('b-events')).toBe(true);
		expect(resolvedCollections.includes('c-events')).toBe(true);
	});

	describe('lifecycle', () => {
		afterEach(() => jest.restoreAllMocks());

		it('should fail to connect when the database is unreachable', async () => {
			const unreachableStore = new PostgresEventStore(eventMap, {
				driver: undefined as never,
				...connectionOptions,
				port: 1,
			});

			await expect(unreachableStore.connect()).rejects.toMatchObject({ code: 'ECONNREFUSED' });
			await unreachableStore.disconnect();
		});

		it('should discard idle connections that fail instead of crashing', async () => {
			// biome-ignore lint/complexity/useLiteralKeys: Needed to check the logged error
			const error = jest.spyOn(eventStore['logger'], 'error').mockImplementation(() => undefined);

			// Make sure the pool holds more than the connection that terminates the others
			await Promise.all([pool.query('SELECT pg_sleep(0.05)'), pool.query('SELECT pg_sleep(0.05)')]);
			const { rows } = await pool.query<{ terminated: boolean }>(
				`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
				WHERE application_name = $1 AND state = 'idle' AND pid <> pg_backend_pid()`,
				[connectionOptions.application_name],
			);
			expect(rows.length).toBeGreaterThan(0);

			for (let attempt = 0; attempt < 100 && error.mock.calls.length < rows.length; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(error).toHaveBeenCalledTimes(rows.length);
			expect(error).toHaveBeenCalledWith(
				'Idle database connection failed: terminating connection due to administrator command',
			);
			const stream = EventStream.for(Account, AccountId.generate());
			await expect(eventStore.getEvent(stream, 1)).rejects.toThrow(new EventNotFoundException(stream.streamId, 1));
		});
	});

	/**
	 * Resolves the definitions of all indexes on a table in the current schema.
	 */
	const getIndexDefinitions = async (table: string): Promise<string[]> => {
		const { rows } = await pool.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes
			WHERE schemaname = current_schema() AND tablename = $1
			ORDER BY indexname COLLATE "C"`,
			[table],
		);
		return rows.map(({ indexdef }) => indexdef);
	};

	/**
	 * Waits until another session is blocked on a lock while inserting into the given table.
	 */
	const waitForBlockedInsert = async (table: string): Promise<void> => {
		for (let attempt = 0; attempt < 250; attempt++) {
			const { rows } = await pool.query<{ waiting: number }>(
				`SELECT count(*)::int AS waiting FROM pg_stat_activity
				WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
				[`%INSERT INTO ${escapeIdentifier(table)}%`],
			);
			if (rows[0].waiting > 0) {
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error(`No insert into ${table} is waiting for a lock`);
	};

	/**
	 * Rejects when the given promise doesn't settle in time, so a starved connection pool fails a test instead of hanging it.
	 */
	const withinTimeout = <T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> => {
		let timer: NodeJS.Timeout;
		return Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds);
			}),
		]).finally(() => clearTimeout(timer));
	};

	describe('connection handling', () => {
		const connectionPool = 'postgres-connection';
		const streamX = EventStream.for(Account, AccountId.generate());
		const streamY = EventStream.for(Account, AccountId.generate());
		// More iterations than the default pg pool size (10), so a leaked connection would exhaust the pool.
		const iterations = 15;

		const readers: Array<[string, () => AsyncGenerator<unknown[]>]> = [
			['getEvents', () => eventStore.getEvents(streamX, { pool: connectionPool, batch: 1 })],
			['getEnvelopes', () => eventStore.getEnvelopes(streamX, { pool: connectionPool, batch: 1 })],
			[
				'getAllEnvelopes',
				() => eventStore.getAllEnvelopes({ pool: connectionPool, since: { year: 2021, month: 1 }, batch: 1 }),
			],
			['listCollections', () => eventStore.listCollections({ batch: 1 })],
		];

		const expectStoreToBeUsable = async () => {
			await expect(eventStore.getEvent(streamY, 2, connectionPool)).resolves.toEqual(events[1]);

			const resolvedEvents: IEvent[] = [];
			for await (const batch of eventStore.getEvents(streamY, { pool: connectionPool })) {
				resolvedEvents.push(...batch);
			}
			expect(resolvedEvents).toEqual(events);

			// Every connection has been handed back to the pool
			expect(pool.idleCount).toBe(pool.totalCount);
			expect(pool.waitingCount).toBe(0);
		};

		beforeAll(async () => {
			await pool.query(`DROP TABLE IF EXISTS ${escapeIdentifier(EventCollection.get(connectionPool))}`);
			await eventStore.ensureCollection(connectionPool);
			await eventStore.appendEvents(streamX, events.length, events, connectionPool);
			await eventStore.appendEvents(streamY, events.length, events, connectionPool);
		});

		afterAll(async () => {
			await pool.query(`DROP TABLE IF EXISTS ${escapeIdentifier(EventCollection.get(connectionPool))}`);
		});

		it.each(readers)(
			'should release the connection when a %s loop is exited early',
			async (_, read) => {
				for (let iteration = 0; iteration < iterations; iteration++) {
					let batches = 0;
					for await (const batch of read()) {
						expect(batch).toHaveLength(1);
						batches++;
						break;
					}
					expect(batches).toBe(1);
				}

				await expectStoreToBeUsable();
			},
			15_000,
		);

		it.each(readers)(
			'should release the connection when the consumer of a %s loop throws',
			async (_, read) => {
				for (let iteration = 0; iteration < iterations; iteration++) {
					await expect(
						(async () => {
							for await (const _batch of read()) {
								throw new Error('consumer failure');
							}
						})(),
					).rejects.toThrow('consumer failure');
				}

				await expectStoreToBeUsable();
			},
			15_000,
		);

		it('should release the connection when an event cannot be deserialized while iterating', async () => {
			const streamZ = EventStream.for(Account, AccountId.generate());
			await eventStore.appendEvents(streamZ, 2, events.slice(0, 2), connectionPool);
			await pool.query(
				`UPDATE ${escapeIdentifier(EventCollection.get(connectionPool))} SET event = 'unregistered-event' WHERE stream_id = $1 AND version = 2`,
				[streamZ.streamId],
			);

			for (let iteration = 0; iteration < iterations; iteration++) {
				const resolvedEvents: IEvent[] = [];
				await expect(
					(async () => {
						for await (const batch of eventStore.getEvents(streamZ, { pool: connectionPool, batch: 1 })) {
							resolvedEvents.push(...batch);
						}
					})(),
				).rejects.toThrow(UnregisteredEventException);
				expect(resolvedEvents).toEqual([events[0]]);
			}

			await expectStoreToBeUsable();
		}, 15_000);

		it('should release the connection when a query fails while iterating', async () => {
			for (let iteration = 0; iteration < iterations; iteration++) {
				await expect(
					(async () => {
						for await (const _batch of eventStore.getEvents(streamX, { pool: 'postgres-missing' })) {
							// the collection doesn't exist, so no batch is ever yielded
						}
					})(),
				).rejects.toThrow('relation "postgres-missing-events" does not exist');
			}

			await expectStoreToBeUsable();
		}, 15_000);

		it('should discard a connection that fails while iterating', async () => {
			const iterator = eventStore.getEvents(streamX, { pool: connectionPool, batch: 1 });
			await expect(iterator.next()).resolves.toEqual({ done: false, value: [events[0]] });

			const { rows } = await pool.query<{ terminated: boolean }>(
				`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
				WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle' AND query LIKE $1`,
				[`%FROM ${escapeIdentifier(EventCollection.get(connectionPool))}%`],
			);
			expect(rows).toEqual([{ terminated: true }]);

			await expect(iterator.next()).rejects.toThrow();
			await expectStoreToBeUsable();
		}, 15_000);

		it('should allow store calls while iterating', async () => {
			const streamCopy = EventStream.for(Account, AccountId.generate());

			for await (const envelopes of eventStore.getEnvelopes(streamX, { pool: connectionPool, batch: 2 })) {
				for (const envelope of envelopes) {
					const { version } = envelope.metadata;

					await expect(eventStore.getEvent(streamX, version, connectionPool)).resolves.toEqual(events[version - 1]);

					const nestedEvents: IEvent[] = [];
					for await (const batch of eventStore.getEvents(streamY, {
						pool: connectionPool,
						fromVersion: version,
						limit: 1,
					})) {
						nestedEvents.push(...batch);
					}
					expect(nestedEvents).toEqual([events[version - 1]]);

					await eventStore.appendEvents(streamCopy, version, [envelope], connectionPool);
				}
			}

			const copiedEvents: IEvent[] = [];
			for await (const batch of eventStore.getEvents(streamCopy, { pool: connectionPool })) {
				copiedEvents.push(...batch);
			}
			expect(copiedEvents).toEqual(events);
			await expectStoreToBeUsable();
		}, 15_000);

		it('should read every event when the batch size is not a positive integer', async () => {
			// pg sends these batch sizes truncated or wrapped, so a batch with fewer rows than requested isn't necessarily the last
			for (const batch of [2.5, 2 ** 31]) {
				const resolvedEvents: IEvent[] = [];
				for await (const batchOfEvents of eventStore.getEvents(streamY, { pool: connectionPool, batch })) {
					resolvedEvents.push(...batchOfEvents);
				}
				expect(resolvedEvents).toEqual(events);
			}

			await expectStoreToBeUsable();
		});

		describe('with more readers than connections', () => {
			let smallStore: PostgresEventStore;
			let smallPool: Pool;

			beforeEach(async () => {
				smallStore = new PostgresEventStore(eventMap, { driver: undefined as never, ...connectionOptions, max: 2 });
				await smallStore.connect();
				// biome-ignore lint/complexity/useLiteralKeys: Needed to check the connections of the store
				smallPool = smallStore['pool'];
			});

			afterEach(async () => {
				// A leaked connection keeps the pool from ending
				await withinTimeout(smallStore.disconnect()).catch(() => undefined);
			});

			it('should not hold a connection while the last batch is consumed', async () => {
				// Every reader calls the store while it holds the last batch, which needs a connection of its own
				await withinTimeout(
					Promise.all(
						Array.from({ length: 6 }, async () => {
							const resolvedEvents: IEvent[] = [];
							for await (const batch of smallStore.getEvents(streamY, { pool: connectionPool })) {
								resolvedEvents.push(...batch);
								await expect(smallStore.getEvent(streamY, 1, connectionPool)).resolves.toEqual(events[0]);
							}
							expect(resolvedEvents).toEqual(events);
						}),
					),
				);

				expect(smallPool.idleCount).toBe(smallPool.totalCount);
			}, 15_000);

			it.each<[string, (store: PostgresEventStore) => AsyncGenerator<unknown[]>]>([
				['getEvents', (store) => store.getEvents(streamY, { pool: connectionPool })],
				['getEnvelopes', (store) => store.getEnvelopes(streamY, { pool: connectionPool })],
				[
					'getAllEnvelopes',
					(store) => store.getAllEnvelopes({ pool: connectionPool, since: { year: 2021, month: 1 } }),
				],
				['listCollections', (store) => store.listCollections({ batch: 1_000 })],
			])(
				'should not hold a connection when a %s read that fits in one batch is never finished',
				async (_, read) => {
					for (let reader = 0; reader < 6; reader++) {
						const { done, value } = await withinTimeout(read(smallStore).next());
						expect(done).toBe(false);
						expect(value.length).toBeGreaterThan(0);
					}

					await expect(withinTimeout(smallStore.getEvent(streamY, 1, connectionPool))).resolves.toEqual(events[0]);
					expect(smallPool.idleCount).toBe(smallPool.totalCount);
				},
				15_000,
			);
		});
	});

	describe('concurrency', () => {
		const concurrencyPool = 'postgres-concurrency';
		const concurrencyTable = EventCollection.get(concurrencyPool);

		beforeAll(async () => {
			await pool.query(`DROP TABLE IF EXISTS ${escapeIdentifier(concurrencyTable)}`);
			await eventStore.ensureCollection(concurrencyPool);
		});

		afterAll(async () => {
			await pool.query(`DROP TABLE IF EXISTS ${escapeIdentifier(concurrencyTable)}`);
		});

		it('should let exactly one of several concurrent appends to the same stream version succeed', async () => {
			for (let round = 0; round < 5; round++) {
				const stream = EventStream.for(Account, AccountId.generate());

				const results = await Promise.allSettled(
					Array.from({ length: 8 }, () => eventStore.appendEvents(stream, 3, events.slice(0, 3), concurrencyPool)),
				);

				const succeeded = results.filter(({ status }) => status === 'fulfilled');
				const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

				expect(succeeded).toHaveLength(1);
				expect(failed).toHaveLength(7);
				for (const { reason } of failed) {
					expect(reason).toBeInstanceOf(EventStoreVersionConflictException);
				}

				const { rows } = await pool.query<{ version: number }>(
					`SELECT version FROM ${escapeIdentifier(concurrencyTable)} WHERE stream_id = $1 ORDER BY version`,
					[stream.streamId],
				);
				expect(rows.map(({ version }) => version)).toEqual([1, 2, 3]);
			}
		}, 15_000);

		it('should report a unique violation during an append as a version conflict', async () => {
			const stream = EventStream.for(Account, AccountId.generate());
			const blocker = new Client(connectionOptions);
			await blocker.connect();

			try {
				// Another writer inserted version 1 but hasn't committed yet, so the version pre-check can't see it.
				await blocker.query('BEGIN');
				await blocker.query(
					`INSERT INTO ${escapeIdentifier(concurrencyTable)} (stream_id, version, event, payload, event_date, event_id, aggregate_id, occurred_on)
					VALUES ($1, 1, 'account-opened', '{}', '2021-01', 'blocker', 'blocker', now())`,
					[stream.streamId],
				);

				const append = eventStore.appendEvents(stream, 3, events.slice(0, 3), concurrencyPool).then(
					() => undefined,
					(error: Error) => error,
				);

				await waitForBlockedInsert(concurrencyTable);
				await blocker.query('COMMIT');

				const error = await append;
				expect(error).toBeInstanceOf(EventStoreVersionConflictException);
				expect(error).toEqual(new EventStoreVersionConflictException(stream, 3, 1));
			} finally {
				await blocker.end();
			}
		}, 15_000);
	});

	describe('collections', () => {
		const longPoolA = `postgres-${'x'.repeat(40)}-a`;
		const longPoolB = `postgres-${'x'.repeat(40)}-b`;
		const tables = [
			EventCollection.get('postgres-index'),
			EventCollection.get('postgres-existing'),
			EventCollection.get('postgres-existing-indexed'),
			EventCollection.get('postgres-race'),
			EventCollection.get('postgres-quo"te'),
			EventCollection.get('postgres-no-privilege'),
			EventCollection.get('postgres-index-failure'),
			EventCollection.get(longPoolA),
			EventCollection.get(longPoolB),
		];

		const createUnindexedTable = async (table: string) =>
			pool.query(
				`CREATE TABLE ${escapeIdentifier(table)} (
					stream_id VARCHAR(120) NOT NULL,
					version INT NOT NULL,
					event VARCHAR(80) NOT NULL,
					payload JSONB NOT NULL,
					event_date VARCHAR(7) NOT NULL,
					event_id VARCHAR(40) NOT NULL,
					aggregate_id VARCHAR(40) NOT NULL,
					occurred_on TIMESTAMPTZ NOT NULL,
					correlation_id VARCHAR(255),
					causation_id VARCHAR(255),
					PRIMARY KEY (stream_id, version)
				)`,
			);

		const dropTables = async () => {
			await Promise.all(tables.map((table) => pool.query(`DROP TABLE IF EXISTS ${escapeIdentifier(table)}`)));
		};

		beforeAll(dropTables);
		afterAll(dropTables);
		afterEach(() => jest.restoreAllMocks());

		it('should create a secondary index for every new collection', async () => {
			const collection = await eventStore.ensureCollection('postgres-index');

			expect(await getIndexDefinitions(collection)).toEqual([
				'CREATE INDEX "idx_postgres-index-events_event_date_id" ON public."postgres-index-events" USING btree (event_date, event_id)',
				'CREATE UNIQUE INDEX "postgres-index-events_pkey" ON public."postgres-index-events" USING btree (stream_id, version)',
			]);
			expect(await getIndexDefinitions(EventCollection.get())).toEqual([
				'CREATE UNIQUE INDEX events_pkey ON public.events USING btree (stream_id, version)',
				'CREATE INDEX idx_events_event_date_id ON public.events USING btree (event_date, event_id)',
			]);
		});

		it('should derive distinct index names within the identifier limit for long pool names', async () => {
			const collections = await Promise.all([
				eventStore.ensureCollection(longPoolA),
				eventStore.ensureCollection(longPoolB),
			]);

			const { rows } = await pool.query<{ tablename: string; indexname: string }>(
				`SELECT tablename, indexname FROM pg_indexes
				WHERE schemaname = current_schema() AND tablename = ANY ($1) AND indexdef LIKE '%(event_date, event_id)'
				ORDER BY tablename COLLATE "C"`,
				[collections],
			);

			expect(rows.map(({ tablename }) => tablename)).toEqual(collections);
			expect(rows[0].indexname).not.toEqual(rows[1].indexname);
			for (const { indexname } of rows) {
				expect(Buffer.byteLength(indexname)).toBeLessThanOrEqual(63);
			}
		});

		it('should not build a missing index on an existing collection but log how to create it', async () => {
			// biome-ignore lint/complexity/useLiteralKeys: Needed to check the logged warning
			const warn = jest.spyOn(eventStore['logger'], 'warn').mockImplementation(() => undefined);
			const table = EventCollection.get('postgres-existing');
			const statement =
				'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_postgres-existing-events_event_date_id" ON "postgres-existing-events" (event_date, event_id)';

			await createUnindexedTable(table);
			await expect(eventStore.ensureCollection('postgres-existing')).resolves.toBe(table);

			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining(statement));
			expect(await getIndexDefinitions(table)).toEqual([
				'CREATE UNIQUE INDEX "postgres-existing-events_pkey" ON public."postgres-existing-events" USING btree (stream_id, version)',
			]);

			// The suggested statement creates the index, after which the warning is no longer logged
			await pool.query(statement);
			warn.mockClear();
			await eventStore.ensureCollection('postgres-existing');
			expect(warn).not.toHaveBeenCalled();
		});

		it('should accept an existing index on the same columns regardless of its name', async () => {
			// biome-ignore lint/complexity/useLiteralKeys: Needed to check the logged warning
			const warn = jest.spyOn(eventStore['logger'], 'warn').mockImplementation(() => undefined);
			const table = EventCollection.get('postgres-existing-indexed');

			await createUnindexedTable(table);
			await pool.query(`CREATE INDEX "postgres_custom_index" ON ${escapeIdentifier(table)} (event_date, event_id)`);
			await eventStore.ensureCollection('postgres-existing-indexed');

			expect(warn).not.toHaveBeenCalled();
			expect(await getIndexDefinitions(table)).toEqual([
				'CREATE UNIQUE INDEX "postgres-existing-indexed-events_pkey" ON public."postgres-existing-indexed-events" USING btree (stream_id, version)',
				'CREATE INDEX postgres_custom_index ON public."postgres-existing-indexed-events" USING btree (event_date, event_id)',
			]);
		});

		it('should log how to create the index of a new collection when the role may not create it', async () => {
			// biome-ignore lint/complexity/useLiteralKeys: Needed to check the logged warning
			const warn = jest.spyOn(eventStore['logger'], 'warn').mockImplementation(() => undefined);
			const query = Client.prototype.query;
			jest.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
				if (typeof args[0] === 'string' && args[0].startsWith('CREATE INDEX IF NOT EXISTS')) {
					return Promise.reject(Object.assign(new Error('must be owner of table'), { code: '42501' }));
				}
				return query.apply(this, args);
			} as never);

			const collection = await eventStore.ensureCollection('postgres-no-privilege');

			expect(collection).toBe('postgres-no-privilege-events');
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining(
					'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_postgres-no-privilege-events_event_date_id" ON "postgres-no-privilege-events" (event_date, event_id)',
				),
			);
			expect(await getIndexDefinitions(collection)).toEqual([
				'CREATE UNIQUE INDEX "postgres-no-privilege-events_pkey" ON public."postgres-no-privilege-events" USING btree (stream_id, version)',
			]);
		});

		it('should roll back a new collection when its index cannot be created', async () => {
			const query = Client.prototype.query;
			jest.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
				if (typeof args[0] === 'string' && args[0].startsWith('CREATE INDEX IF NOT EXISTS')) {
					return Promise.reject(new Error('could not extend file'));
				}
				return query.apply(this, args);
			} as never);

			await expect(eventStore.ensureCollection('postgres-index-failure')).rejects.toThrow(
				EventStoreCollectionCreationException,
			);

			const { rows } = await pool.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [
				escapeIdentifier(EventCollection.get('postgres-index-failure')),
			]);
			expect(rows).toEqual([{ exists: false }]);
		});

		it('should ensure the same collection concurrently', async () => {
			const collections = await Promise.all(
				Array.from({ length: 8 }, () => eventStore.ensureCollection('postgres-race')),
			);

			expect(new Set(collections)).toEqual(new Set([EventCollection.get('postgres-race')]));
			expect(await getIndexDefinitions(EventCollection.get('postgres-race'))).toHaveLength(2);
		});

		it('should support pool names that need quoting', async () => {
			const quotedPool = 'postgres-quo"te';
			const stream = EventStream.for(Account, AccountId.generate());

			const collection = await eventStore.ensureCollection(quotedPool);
			expect(collection).toBe('postgres-quo"te-events');
			expect(await getIndexDefinitions(collection)).toHaveLength(2);

			const appended = await eventStore.appendEvents(stream, events.length, events, quotedPool);
			await expect(eventStore.appendEvents(stream, events.length, events, quotedPool)).rejects.toThrow(
				EventStoreVersionConflictException,
			);

			await expect(eventStore.getEvent(stream, 1, quotedPool)).resolves.toEqual(events[0]);
			await expect(eventStore.getEnvelope(stream, 1, quotedPool)).resolves.toEqual(appended[0]);

			const resolvedEvents: IEvent[] = [];
			for await (const batch of eventStore.getEvents(stream, { pool: quotedPool })) {
				resolvedEvents.push(...batch);
			}
			expect(resolvedEvents).toEqual(events);

			const resolvedEnvelopes: EventEnvelope[] = [];
			for await (const batch of eventStore.getEnvelopes(stream, { pool: quotedPool })) {
				resolvedEnvelopes.push(...batch);
			}
			expect(resolvedEnvelopes).toEqual(appended);

			const allEnvelopes: EventEnvelope[] = [];
			for await (const batch of eventStore.getAllEnvelopes({ pool: quotedPool, since: { year: 2021, month: 1 } })) {
				allEnvelopes.push(...batch);
			}
			expect(allEnvelopes).toEqual(appended);

			const collections: IEventCollection[] = [];
			for await (const batch of eventStore.listCollections()) {
				collections.push(...batch);
			}
			expect(collections).toContain(collection);
		});
	});
});
