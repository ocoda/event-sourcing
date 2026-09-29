import { randomUUID } from 'node:crypto';
import {
	EventCollection,
	EventCollectionNotFoundException,
	EventEnvelope,
	EventId,
	EventNotFoundException,
	EventSourcingErrorCode,
	EventStoreCollectionCreationException,
	EventStorePersistenceException,
	EventStoreSchemaException,
	EventStoreVersionConflictException,
	EventStream,
	ExpectedVersion,
	type IEvent,
	type IEventCollection,
	SnapshotStream,
	StreamReadingDirection,
	UnregisteredEventException,
	isEventSourcingError,
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
	postgresTestConfig,
} from '@ocoda/event-sourcing-testing/unit';
import { Client, DatabaseError, type Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { type TestEventStore, createEventStore, createSnapshotStore, dropCollections } from '../support/stores.js';

const connectionOptions = {
	...postgresTestConfig(),
	application_name: 'postgres-event-store-spec',
};

const drain = async <T>(batches: AsyncIterable<T[]>): Promise<T[]> => {
	const items: T[] = [];
	for await (const batch of batches) {
		items.push(...batch);
	}
	return items;
};

const collectBatches = async <T>(batches: AsyncIterable<T[]>): Promise<T[][]> => {
	const result: T[][] = [];
	for await (const batch of batches) {
		result.push(batch);
	}
	return result;
};

const positionsOf = (envelopes: EventEnvelope[]) => envelopes.map(({ metadata }) => metadata.globalPosition);

const newStream = () => EventStream.for(Account, AccountId.generate());

/**
 * A pool name that no other spec (or run) uses.
 */
const uniquePool = (name: string) => `pg-${name}-${randomUUID().slice(0, 8)}`;

describe(PostgresEventStore, () => {
	let eventStore: PostgresEventStore;
	let envelopesAccountA: EventEnvelope[];
	let envelopesAccountB: EventEnvelope[];
	let publish: TestEventStore['publish'];

	let pool: Pool;
	/** Tables (and catalog rows) the specs create, dropped at the end. */
	const created: string[] = [];
	const track = <T extends string>(collection: T): T => {
		created.push(collection);
		return collection;
	};

	const eventMap = getEventMap();
	const events = getEvents();

	beforeAll(async () => {
		({ store: eventStore, publish } = createEventStore(connectionOptions, eventMap));

		await eventStore.connect();
		pool = eventStore['pool']!;
		await dropCollections(pool, [EventCollection.get()]);
		await eventStore.ensureCollection();
		track(EventCollection.get());

		envelopesAccountA = getAccountAEventEnvelopes(eventMap, events);
		envelopesAccountB = getAccountBEventEnvelopes(eventMap, events);
	});

	afterAll(async () => {
		await dropCollections(pool, created);
		await eventStore.disconnect();
	});

	afterEach(() => vi.restoreAllMocks());

	/**
	 * The catalog row of a collection.
	 */
	const catalogRow = async (collection: string) => {
		const { rows } = await pool.query<{ kind: string; schema_version: number; last_position: string }>(
			'SELECT kind, schema_version, last_position::text AS last_position FROM event_sourcing_collections WHERE name = $1',
			[collection],
		);
		return rows[0];
	};

	/**
	 * The definitions of all indexes on a table in the current schema.
	 */
	const getIndexDefinitions = async (table: string): Promise<string[]> => {
		const { rows } = await pool.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes
			WHERE schemaname = current_schema() AND tablename = $1
			ORDER BY indexname COLLATE "C"`,
			[table],
		);
		return rows.map(({ indexdef }) => indexdef.replace(/ ON \w+\./, ' ON '));
	};

	/**
	 * Creates a table with the 3.x schema, as 3.0.2 does.
	 */
	const createV1Table = async (table: string) =>
		pool.query(
			`CREATE TABLE ${escapeIdentifier(track(table))} (
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

	describe('appending and reading', () => {
		it('should append event envelopes and number them from 1', async () => {
			const appendedA = await eventStore.appendEvents(eventStreamAccountA, envelopesAccountA.length, envelopesAccountA);
			const appendedB = await eventStore.appendEvents(eventStreamAccountB, envelopesAccountB.length, envelopesAccountB);

			const { rows: entities } = await pool.query<PostgresEventEntity>(`
				SELECT e.*, e.global_position::text AS global_position FROM "${EventCollection.get()}" e ORDER BY e.global_position ASC
			`);

			expect(entities).toHaveLength(events.length * 2);
			expect(entities.map(({ global_position }) => global_position)).toEqual(
				Array.from({ length: events.length * 2 }, (_, index) => String(index + 1)),
			);
			expect([...positionsOf(appendedA), ...positionsOf(appendedB)]).toEqual(
				Array.from({ length: events.length * 2 }, (_, index) => BigInt(index + 1)),
			);

			for (const [index, entity] of entities.slice(0, events.length).entries()) {
				expect(entity.stream_id).toEqual(eventStreamAccountA.streamId);
				expect(entity.event).toEqual(envelopesAccountA[index].event);
				expect(entity.payload).toEqual(envelopesAccountA[index].payload);
				expect(entity.aggregate_id).toEqual(envelopesAccountA[index].metadata.aggregateId);
				expect(entity.event_id).toEqual(envelopesAccountA[index].metadata.eventId.value);
				expect(entity.occurred_on).toEqual(envelopesAccountA[index].metadata.occurredOn);
				expect(entity.version).toEqual(envelopesAccountA[index].metadata.version);
				expect(entity.headers).toBeNull();
				expect(entity.event_version).toBeNull();
				expect(entity).not.toHaveProperty('event_date');
			}

			expect(publish).toHaveBeenCalledTimes(events.length * 2);
			expect(await catalogRow(EventCollection.get())).toEqual({
				kind: 'events',
				schema_version: 2,
				last_position: String(events.length * 2),
			});
		});

		it('should append events to the collection of a pool', async () => {
			const accountId = AccountId.generate();
			const stream = EventStream.for(Account, accountId);
			const expected = getAccountEventEnvelopes(accountId, eventMap, events);
			const singular = uniquePool('singular');

			track(await eventStore.ensureCollection(singular));
			const appended = await eventStore.appendEvents(stream, events, {
				expectedVersion: ExpectedVersion.NoStream,
				pool: singular,
			});

			expect(positionsOf(appended)).toEqual(expected.map((_, index) => BigInt(index + 1)));
			const { rows: entities } = await pool.query<PostgresEventEntity>(
				`SELECT * FROM ${escapeIdentifier(EventCollection.get(singular))} ORDER BY version ASC`,
			);
			for (const [index, entity] of entities.entries()) {
				expect(entity.stream_id).toEqual(stream.streamId);
				expect(entity.event).toEqual(expected[index].event);
				expect(entity.payload).toEqual(expected[index].payload);
				expect(entity.occurred_on).toBeInstanceOf(Date);
				expect(entity.version).toEqual(index + 1);
			}
		});

		it('should store and read the metadata, headers and event version of the envelopes', async () => {
			const stream = newStream();
			const imported = EventEnvelope.from('account-opened', eventMap.serializeEvent(events[0]), {
				eventId: EventId.generate(new Date('2022-03-04T05:06:07.089Z')),
				aggregateId: stream.aggregateId,
				version: 1,
				occurredOn: new Date('2022-03-04T05:06:07.089Z'),
				correlationId: 'imported-correlation',
				headers: {
					$traceparent: '00-abc-def-01',
					tenant: 'acme',
					'ünïcode ✓': 'ok',
					count: 2.5,
					flag: false,
					none: null,
				},
				eventVersion: 3,
			});

			const appended = await eventStore.appendEvents(stream, [imported, events[1]], {
				expectedVersion: ExpectedVersion.NoStream,
				metadata: { correlationId: 'append-correlation', causationId: 'append-causation', headers: { tenant: 'b' } },
			});

			const [first, second] = await drain(eventStore.getEnvelopes(stream));
			expect(first.metadata).toEqual({
				...imported.metadata,
				causationId: 'append-causation',
				globalPosition: appended[0].metadata.globalPosition,
			});
			expect(second.metadata).toMatchObject({
				correlationId: 'append-correlation',
				causationId: 'append-causation',
				headers: { tenant: 'b' },
				globalPosition: appended[1].metadata.globalPosition,
			});
			expect(second.metadata).not.toHaveProperty('eventVersion');
			await expect(eventStore.getEnvelope(stream, 1)).resolves.toEqual(first);

			const { rows } = await pool.query<{ headers: unknown; event_version: number | null }>(
				`SELECT headers, event_version FROM "${EventCollection.get()}" WHERE stream_id = $1 ORDER BY version`,
				[stream.streamId],
			);
			expect(rows).toEqual([
				{ headers: imported.metadata.headers, event_version: 3 },
				{ headers: { tenant: 'b' }, event_version: null },
			]);
		});

		it('should throw when the stream is not at the expected version', async () => {
			const lastEvent = events[events.length - 1];
			const lastVersion = events.length;
			await expect(
				eventStore.appendEvents(eventStreamAccountA, [lastEvent], { expectedVersion: lastVersion - 2 }),
			).rejects.toThrow(
				new EventStoreVersionConflictException({
					stream: eventStreamAccountA,
					expectedVersion: lastVersion - 2,
					actualVersion: lastVersion,
				}),
			);
			await expect(eventStore.appendEvents(eventStreamAccountA, lastVersion, [lastEvent])).rejects.toMatchObject({
				code: EventSourcingErrorCode.EventStoreVersionConflict,
				expectedVersion: lastVersion - 1,
				actualVersion: lastVersion,
			});
		});

		it('should refuse an append to a pool that was never created, without creating it', async () => {
			const missing = uniquePool('missing');
			const error = await eventStore
				.appendEvents(newStream(), events.slice(0, 3), { expectedVersion: 0, pool: missing })
				.then(
					() => undefined,
					(rejection: unknown) => rejection,
				);

			expect(error).toMatchObject({
				name: EventStorePersistenceException.name,
				outcome: 'not-persisted',
				collection: EventCollection.get(missing),
			});
			expect(isEventSourcingError((error as Error).cause, EventSourcingErrorCode.EventCollectionNotFound)).toBe(true);
			await expect(catalogRow(EventCollection.get(missing))).resolves.toBeUndefined();
		});

		it('should retrieve a single event from a specified stream', async () => {
			await expect(eventStore.getEvent(eventStreamAccountA, envelopesAccountA[3].metadata.version)).resolves.toEqual(
				events[3],
			);
		});

		it('should filter events by stream and version', async () => {
			expect(await drain(eventStore.getEvents(eventStreamAccountA))).toEqual(events);
			expect(await drain(eventStore.getEvents(eventStreamAccountA, { fromVersion: 3 }))).toEqual(events.slice(2));
		});

		it("should throw when an event isn't found in a specified stream", async () => {
			const stream = newStream();
			await expect(eventStore.getEvent(stream, 5)).rejects.toThrow(
				new EventNotFoundException({ streamId: stream.streamId, version: 5 }),
			);
			await expect(eventStore.getEnvelope(stream, 5)).rejects.toThrow(EventNotFoundException);
		});

		it('should retrieve events backwards, limited and batched', async () => {
			expect(
				await drain(eventStore.getEvents(eventStreamAccountA, { direction: StreamReadingDirection.BACKWARD })),
			).toEqual(events.slice().reverse());
			expect(
				await drain(
					eventStore.getEvents(eventStreamAccountA, { fromVersion: 4, direction: StreamReadingDirection.BACKWARD }),
				),
			).toEqual(events.slice(3).reverse());
			expect(await drain(eventStore.getEvents(eventStreamAccountA, { limit: 3 }))).toEqual(events.slice(0, 3));
			expect(
				(await collectBatches(eventStore.getEvents(eventStreamAccountA, { batch: 2 }))).map((batch) => batch.length),
			).toEqual([2, 2, 2]);
		});

		it('should retrieve envelopes with their global positions', async () => {
			const envelopes = await drain(eventStore.getEnvelopes(eventStreamAccountA));

			expect(envelopes).toHaveLength(envelopesAccountA.length);
			for (const [index, envelope] of envelopes.entries()) {
				expect(envelope.event).toEqual(envelopesAccountA[index].event);
				expect(envelope.payload).toEqual(envelopesAccountA[index].payload);
				expect(envelope.metadata.eventId.value).toEqual(envelopesAccountA[index].metadata.eventId.value);
				expect(envelope.metadata.occurredOn).toEqual(envelopesAccountA[index].metadata.occurredOn);
				expect(envelope.metadata.version).toEqual(index + 1);
				expect(envelope.metadata.globalPosition).toBe(BigInt(index + 1));
				expect(envelope.metadata).not.toHaveProperty('correlationId');
				expect(envelope.metadata).not.toHaveProperty('headers');
			}
			await expect(eventStore.getEnvelope(eventStreamAccountA, 2)).resolves.toEqual(envelopes[1]);
		});

		it('should read the stream version', async () => {
			await expect(eventStore.getStreamVersion(eventStreamAccountA)).resolves.toBe(events.length);
			await expect(eventStore.getStreamVersion(newStream())).resolves.toBe(0);
		});

		it('should list the event collections of the catalog, in batches', async () => {
			const pools = [uniquePool('list-a'), uniquePool('list-b'), uniquePool('list-c')];
			await Promise.all(pools.map(async (listed) => track(await eventStore.ensureCollection(listed))));
			// Neither a 3.x table nor a snapshot table is an event collection of the catalog
			await createV1Table(EventCollection.get(uniquePool('list-v1')));

			const batches = await collectBatches(eventStore.listCollections({ batch: 2 }));
			const collections = batches.flat();

			expect(batches.every((batch) => batch.length <= 2)).toBe(true);
			expect(collections).toEqual(expect.arrayContaining(pools.map((listed) => EventCollection.get(listed))));
			expect(collections).toEqual([...collections].sort());
			expect(new Set(collections).size).toBe(collections.length);
			expect(collections.every((collection) => collection.endsWith('events'))).toBe(true);
			expect(collections.filter((collection) => collection.includes('list-v1'))).toEqual([]);
		});
	});

	describe('readAll', () => {
		const readPool = uniquePool('read-all');
		const appended: EventEnvelope[] = [];

		beforeAll(async () => {
			track(await eventStore.ensureCollection(readPool));
			// More than 10 positions, so that an order by the text of the position would show
			for (let round = 0; round < 4; round++) {
				appended.push(
					...(await eventStore.appendEvents(newStream(), events.slice(0, 3), { expectedVersion: 0, pool: readPool })),
				);
			}
		});

		it('should read a pool in the numeric order of the positions', async () => {
			const read = await drain(eventStore.readAll({ pool: readPool }));

			expect(positionsOf(read)).toEqual(appended.map((_, index) => BigInt(index + 1)));
			expect(read).toEqual(appended);
		});

		it('should read from an inclusive position, in batches', async () => {
			expect(positionsOf(await drain(eventStore.readAll({ pool: readPool, fromPosition: 10n })))).toEqual([
				10n,
				11n,
				12n,
			]);
			expect(await drain(eventStore.readAll({ pool: readPool, fromPosition: 0n }))).toHaveLength(12);
			expect(await drain(eventStore.readAll({ pool: readPool, fromPosition: 13n }))).toEqual([]);
			expect(
				(await collectBatches(eventStore.readAll({ pool: readPool, batch: 5 }))).map((batch) => batch.length),
			).toEqual([5, 5, 2]);
			expect(
				(await collectBatches(eventStore.readAll({ pool: readPool, batch: 4 }))).map((batch) => batch.length),
			).toEqual([4, 4, 4]);
		});

		it('should read events that were appended while it reads', async () => {
			const extra = uniquePool('read-all-live');
			track(await eventStore.ensureCollection(extra));
			await eventStore.appendEvents(newStream(), events.slice(0, 2), { expectedVersion: 0, pool: extra });

			const read: EventEnvelope[] = [];
			for await (const batch of eventStore.readAll({ pool: extra, batch: 2 })) {
				read.push(...batch);
				if (read.length === 2) {
					await eventStore.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: extra });
				}
			}

			expect(positionsOf(read)).toEqual([1n, 2n, 3n]);
		});

		it('should reject invalid positions and batch sizes', async () => {
			await expect(drain(eventStore.readAll({ pool: readPool, batch: 0 }))).rejects.toThrow(RangeError);
			await expect(
				drain(eventStore.readAll({ pool: readPool, fromPosition: -1n as unknown as bigint })),
			).rejects.toThrow(RangeError);
		});

		it('should read positions beyond the range of a number exactly', async () => {
			const big = uniquePool('big-positions');
			const collection = track(await eventStore.ensureCollection(big));
			const start = 2n ** 60n;
			await pool.query('UPDATE event_sourcing_collections SET last_position = $2 WHERE name = $1', [
				collection,
				start.toString(),
			]);

			const [envelope] = await eventStore.appendEvents(newStream(), events.slice(0, 1), {
				expectedVersion: 0,
				pool: big,
			});

			expect(envelope.metadata.globalPosition).toBe(start + 1n);
			expect(positionsOf(await drain(eventStore.readAll({ pool: big, fromPosition: start })))).toEqual([start + 1n]);
		});
	});

	describe('unknown pools and 3.x tables', () => {
		it('should reject the reads of a pool whose collection was never created', async () => {
			const missing = uniquePool('unknown');
			const fields = { collection: EventCollection.get(missing), pool: missing };
			const stream = newStream();

			await expect(eventStore.getEnvelope(stream, 1, missing)).rejects.toMatchObject(fields);
			await expect(eventStore.getEvent(stream, 1, missing)).rejects.toThrow(EventCollectionNotFoundException);
			await expect(drain(eventStore.getEnvelopes(stream, { pool: missing }))).rejects.toThrow(
				EventCollectionNotFoundException,
			);
			await expect(drain(eventStore.readAll({ pool: missing }))).rejects.toThrow(EventCollectionNotFoundException);
			await expect(eventStore.getStreamVersion(stream, missing)).rejects.toThrow(EventCollectionNotFoundException);
		});

		it('should refuse to use a 3.x table, and never migrate it', async () => {
			const legacy = uniquePool('legacy');
			const table = EventCollection.get(legacy);
			await createV1Table(table);
			await pool.query(
				`INSERT INTO ${escapeIdentifier(table)} (stream_id, version, event, payload, event_date, event_id, aggregate_id, occurred_on)
				VALUES ('account-1', 1, 'account-opened', '{}', '2021-01', '01EXAMPLE00000000000000000', '1', now())`,
			);

			await expect(eventStore.ensureCollection(legacy)).rejects.toMatchObject({
				name: EventStoreSchemaException.name,
				collection: table,
				found: 'v1',
				remedy: expect.stringContaining('PostgresEventStore.migrate('),
			});
			await expect(drain(eventStore.readAll({ pool: legacy }))).rejects.toMatchObject({ found: 'v1' });
			await expect(drain(eventStore.getEnvelopes(newStream(), { pool: legacy }))).rejects.toMatchObject({
				found: 'v1',
			});

			// Even with a catalog row, an append fails before anything is written
			await pool.query("INSERT INTO event_sourcing_collections (name, kind, schema_version) VALUES ($1, 'events', 2)", [
				table,
			]);
			const error = await eventStore
				.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: legacy })
				.catch((rejection: unknown) => rejection);
			expect(error).toMatchObject({ outcome: 'not-persisted' });
			expect((error as Error).cause).toMatchObject({ name: EventStoreSchemaException.name, found: 'v1' });

			const { rows } = await pool.query(`SELECT * FROM ${escapeIdentifier(table)}`);
			expect(rows).toHaveLength(1);
			expect(await getIndexDefinitions(table)).toHaveLength(1);
		});

		it('should refuse a partly migrated table', async () => {
			const partial = uniquePool('partial');
			const table = EventCollection.get(partial);
			await createV1Table(table);
			await pool.query(`ALTER TABLE ${escapeIdentifier(table)} ADD COLUMN global_position BIGINT`);

			await expect(eventStore.ensureCollection(partial)).rejects.toMatchObject({
				name: EventStoreSchemaException.name,
				found: 'v1-partial',
			});
		});
	});

	describe('lifecycle', () => {
		it('should fail to connect when the database is unreachable', async () => {
			const { store: unreachableStore } = createEventStore({ ...connectionOptions, port: 1 }, eventMap);

			await expect(unreachableStore.connect()).rejects.toMatchObject({ code: 'ECONNREFUSED' });
			await unreachableStore.disconnect();
		});

		it('should disconnect once, and do nothing before connecting', async () => {
			const { store } = createEventStore(connectionOptions, eventMap);
			await expect(store.disconnect()).resolves.toBeUndefined();

			await store.connect();
			await expect(store.disconnect()).resolves.toBeUndefined();
			await expect(store.disconnect()).resolves.toBeUndefined();
			await expect(store.getStreamVersion(newStream())).rejects.toThrow('PostgresEventStore is not connected');
		});

		it("should not hand the store's own options to the pg pool", async () => {
			const { store } = createEventStore({ ...connectionOptions, ddl: 'none', useDefaultPool: false } as never);
			await store.connect();
			try {
				const options = (store['pool'] as unknown as { options: Record<string, unknown> }).options;
				expect(options).not.toHaveProperty('ddl');
				expect(options).not.toHaveProperty('useDefaultPool');
				expect(options).not.toHaveProperty('driver');
				expect(options.application_name).toBe(connectionOptions.application_name);
			} finally {
				await store.disconnect();
			}
		});

		it('should discard idle connections that fail instead of crashing', async () => {
			const error = vi.spyOn(eventStore['logger'], 'error').mockImplementation(() => undefined);

			// Make sure the pool holds more than the connection that terminates the others
			await Promise.all([pool.query('SELECT pg_sleep(0.05)'), pool.query('SELECT pg_sleep(0.05)')]);
			const { rows } = await pool.query<{ terminated: boolean }>(
				`SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
				WHERE datname = current_database() AND application_name = $1 AND state = 'idle' AND pid <> pg_backend_pid()`,
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
			const stream = newStream();
			await expect(eventStore.getEvent(stream, 1)).rejects.toThrow(
				new EventNotFoundException({ streamId: stream.streamId, version: 1 }),
			);
		});
	});

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
		const connectionPool = uniquePool('connection');
		const streamX = newStream();
		const streamY = newStream();
		// More iterations than the default pg pool size (10), so a leaked connection would exhaust the pool.
		const iterations = 15;

		const readers: Array<[string, () => AsyncGenerator<unknown[]>]> = [
			['getEvents', () => eventStore.getEvents(streamX, { pool: connectionPool, batch: 1 })],
			['getEnvelopes', () => eventStore.getEnvelopes(streamX, { pool: connectionPool, batch: 1 })],
			['readAll', () => eventStore.readAll({ pool: connectionPool, batch: 1 })],
			['listCollections', () => eventStore.listCollections({ batch: 1 })],
		];

		const expectStoreToBeUsable = async () => {
			await expect(eventStore.getEvent(streamY, 2, connectionPool)).resolves.toEqual(events[1]);
			expect(await drain(eventStore.getEvents(streamY, { pool: connectionPool }))).toEqual(events);

			// Every connection has been handed back to the pool
			expect(pool.idleCount).toBe(pool.totalCount);
			expect(pool.waitingCount).toBe(0);
		};

		beforeAll(async () => {
			track(await eventStore.ensureCollection(connectionPool));
			await eventStore.appendEvents(streamX, events.length, events, connectionPool);
			await eventStore.appendEvents(streamY, events.length, events, connectionPool);
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
			const streamZ = newStream();
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
				await expect(drain(eventStore.getEvents(streamX, { pool: 'postgres-missing' }))).rejects.toThrow(
					EventCollectionNotFoundException,
				);
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
			const streamCopy = newStream();

			for await (const envelopes of eventStore.getEnvelopes(streamX, { pool: connectionPool, batch: 2 })) {
				for (const envelope of envelopes) {
					const { version } = envelope.metadata;

					await expect(eventStore.getEvent(streamX, version, connectionPool)).resolves.toEqual(events[version - 1]);
					expect(
						await drain(eventStore.getEvents(streamY, { pool: connectionPool, fromVersion: version, limit: 1 })),
					).toEqual([events[version - 1]]);

					await eventStore.appendEvents(streamCopy, [eventMap.deserializeEvent(envelope.event, envelope.payload)], {
						expectedVersion: version - 1,
						pool: connectionPool,
					});
				}
			}

			expect(await drain(eventStore.getEvents(streamCopy, { pool: connectionPool }))).toEqual(events);
			await expectStoreToBeUsable();
		}, 15_000);

		it('should read every event when the batch size is not a positive integer', async () => {
			// pg sends these batch sizes truncated or wrapped, so a batch with fewer rows than requested isn't necessarily the last
			for (const batch of [2.5, 2 ** 31]) {
				expect(await drain(eventStore.getEvents(streamY, { pool: connectionPool, batch }))).toEqual(events);
			}

			await expectStoreToBeUsable();
		});

		describe('with more readers than connections', () => {
			let smallStore: PostgresEventStore;
			let smallPool: Pool;

			beforeEach(async () => {
				({ store: smallStore } = createEventStore({ ...connectionOptions, max: 2 }, eventMap));
				await smallStore.connect();
				smallPool = smallStore['pool']!;
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
				['readAll', (store) => store.readAll({ pool: connectionPool })],
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
		const concurrencyPool = uniquePool('concurrency');
		const concurrencyTable = EventCollection.get(concurrencyPool);

		beforeAll(async () => {
			track(await eventStore.ensureCollection(concurrencyPool));
		});

		it('should let exactly one of several concurrent appends to the same stream version succeed', async () => {
			for (let round = 0; round < 5; round++) {
				const stream = newStream();

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

			// The appends that lost burned no position
			const read = await drain(eventStore.readAll({ pool: concurrencyPool }));
			expect(positionsOf(read)).toEqual(read.map((_, index) => BigInt(index + 1)));
			expect((await catalogRow(concurrencyTable)).last_position).toBe(String(read.length));
		}, 15_000);

		it('should report a unique violation of the stream version during an append as a version conflict', async () => {
			const stream = newStream();
			const blocker = new Client(connectionOptions);
			await blocker.connect();

			try {
				// Another writer inserted version 1 but hasn't committed yet, so the version pre-check can't see it.
				await blocker.query('BEGIN');
				await blocker.query(
					`INSERT INTO ${escapeIdentifier(concurrencyTable)} (stream_id, version, event, payload, event_id, aggregate_id, occurred_on, global_position)
					VALUES ($1, 1, 'account-opened', '{}', 'blocker', 'blocker', now(), 9000000000000000000)`,
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
				expect(error).toMatchObject({
					streamId: stream.streamId,
					pool: concurrencyPool,
					expectedVersion: 0,
					cause: expect.objectContaining({ code: '23505', constraint: `${concurrencyTable}_pkey` }),
				});
			} finally {
				await blocker.query(`DELETE FROM ${escapeIdentifier(concurrencyTable)} WHERE stream_id = $1`, [
					stream.streamId,
				]);
				await blocker.end();
			}
		}, 15_000);

		it.each([
			['one connection, two appends at the same version', 1, 2, 0],
			['two connections, sixteen appends at any version', 2, 16, ExpectedVersion.Any],
			['the default ten connections, thirty-two appends at any version', undefined, 32, ExpectedVersion.Any],
		] as const)(
			'should tell conflicts from drift without a second connection, with %s',
			async (_, max, appends, expectedVersion) => {
				for (let round = 0; round < 3; round++) {
					// A new store each round, so the primary key names aren't cached yet
					const { store } = createEventStore({ ...connectionOptions, ...(max ? { max } : {}) }, eventMap);
					await store.connect();
					try {
						const stream = newStream();
						const results = await withinTimeout(
							Promise.allSettled(
								Array.from({ length: appends }, () =>
									store.appendEvents(stream, events.slice(0, 1), { expectedVersion, pool: concurrencyPool }),
								),
							),
							15_000,
						);

						const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
						for (const { reason } of failed) {
							// An `Any` append can still lose every retry under contention (ADR 0001 D2)
							expect(reason).toBeInstanceOf(EventStoreVersionConflictException);
						}
						if (expectedVersion === 0) {
							expect(failed).toHaveLength(appends - 1);
						}
						await expect(store.getStreamVersion(stream, concurrencyPool)).resolves.toBe(appends - failed.length);
					} finally {
						await withinTimeout(store.disconnect());
					}
				}
			},
			60_000,
		);

		it('should append under explicit READ COMMITTED when the database defaults to REPEATABLE READ', async () => {
			const { store } = createEventStore(
				{ ...connectionOptions, options: '-c default_transaction_isolation=repeatable\\ read' },
				eventMap,
			);
			await store.connect();
			try {
				const { rows } = await store['pool']!.query<{ isolation: string }>('SELECT current_setting($1) AS isolation', [
					'default_transaction_isolation',
				]);
				expect(rows).toEqual([{ isolation: 'repeatable read' }]);

				// Every append waits for the counter row of the pool that the others update
				const results = await Promise.allSettled(
					Array.from({ length: 8 }, async () => {
						const stream = newStream();
						for (let version = 0; version < 20; version += 2) {
							await store.appendEvents(stream, events.slice(0, 2), {
								expectedVersion: version,
								pool: concurrencyPool,
							});
						}
					}),
				);

				expect(results.filter(({ status }) => status === 'rejected')).toEqual([]);
			} finally {
				await store.disconnect();
			}
		}, 30_000);

		it('should report a duplicate stream version in a partition of a partitioned table as a version conflict', async () => {
			const partitioned = uniquePool('partitioned');
			const table = track(EventCollection.get(partitioned));
			await pool.query(
				`CREATE TABLE ${escapeIdentifier(table)} (
					stream_id TEXT NOT NULL, version INTEGER NOT NULL, event TEXT NOT NULL, payload JSONB NOT NULL,
					event_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, occurred_on TIMESTAMPTZ NOT NULL,
					correlation_id TEXT, causation_id TEXT, global_position BIGINT NOT NULL, headers JSONB, event_version INTEGER,
					PRIMARY KEY (stream_id, version)
				) PARTITION BY HASH (stream_id)`,
			);
			for (const remainder of [0, 1]) {
				await pool.query(
					`CREATE TABLE ${escapeIdentifier(`${table}_${remainder}`)} PARTITION OF ${escapeIdentifier(table)}
					FOR VALUES WITH (MODULUS 2, REMAINDER ${remainder})`,
				);
			}
			// No unique index on the positions (it would have to include the partition key): register it by hand
			await pool.query(
				"INSERT INTO event_sourcing_collections (name, kind, schema_version, last_position) VALUES ($1, 'events', 2, 0)",
				[table],
			);
			const { store } = createEventStore(connectionOptions, eventMap);
			await store.connect();
			const blocker = new Client(connectionOptions);
			await blocker.connect();
			try {
				const stream = newStream();
				await blocker.query('BEGIN');
				await blocker.query(
					`INSERT INTO ${escapeIdentifier(table)} (stream_id, version, event, payload, event_id, aggregate_id, occurred_on, global_position)
					VALUES ($1, 1, 'account-opened', '{}', 'blocker', 'blocker', now(), 1000)`,
					[stream.streamId],
				);
				const append = store.appendEvents(stream, events.slice(0, 1), { expectedVersion: 0, pool: partitioned }).then(
					() => undefined,
					(error: Error) => error,
				);
				await waitForBlockedInsert(table);
				await blocker.query('COMMIT');

				const error = await append;
				expect(error).toBeInstanceOf(EventStoreVersionConflictException);
				expect(error).toMatchObject({
					cause: expect.objectContaining({ code: '23505', constraint: expect.stringMatching(/_[01]_pkey$/) }),
				});
			} finally {
				await blocker.end();
				await store.disconnect();
				await pool.query(`DROP TABLE IF EXISTS ${escapeIdentifier(table)}`);
			}
		}, 15_000);

		it('should refuse an append when the position counter drifted, and heal the counter on ensureCollection', async () => {
			const drift = uniquePool('drift');
			const table = track(await eventStore.ensureCollection(drift));
			await eventStore.appendEvents(newStream(), events.slice(0, 3), { expectedVersion: 0, pool: drift });
			await pool.query('UPDATE event_sourcing_collections SET last_position = 1 WHERE name = $1', [table]);
			const logged = vi.spyOn(eventStore['logger'], 'error').mockImplementation(() => undefined);

			const stream = newStream();
			await expect(
				eventStore.appendEvents(stream, events.slice(0, 1), { expectedVersion: 0, pool: drift }),
			).rejects.toMatchObject({
				outcome: 'not-persisted',
				cause: expect.objectContaining({ code: '23505' }),
			});
			expect(logged).toHaveBeenCalledWith(expect.stringContaining('ensureCollection() heals the counter'));
			expect(await catalogRow(table)).toMatchObject({ last_position: '1' });

			await eventStore.ensureCollection(drift);
			expect(await catalogRow(table)).toMatchObject({ last_position: '3' });
			const [appended] = await eventStore.appendEvents(stream, events.slice(0, 1), { expectedVersion: 0, pool: drift });
			expect(appended.metadata.globalPosition).toBe(4n);
		});

		it('should refuse an append to a pool whose catalog row is missing, and continue its positions once registered', async () => {
			const unregistered = uniquePool('unregistered');
			const table = track(await eventStore.ensureCollection(unregistered));
			await eventStore.appendEvents(newStream(), events.slice(0, 2), { expectedVersion: 0, pool: unregistered });
			await pool.query('DELETE FROM event_sourcing_collections WHERE name = $1', [table]);

			const error = await eventStore
				.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: unregistered })
				.catch((rejection: unknown) => rejection);
			expect(error).toMatchObject({ outcome: 'not-persisted' });
			expect(isEventSourcingError((error as Error).cause, EventSourcingErrorCode.EventCollectionNotFound)).toBe(true);
			expect(await drain(eventStore.readAll({ pool: unregistered }))).toHaveLength(2);

			await eventStore.ensureCollection(unregistered);
			const [appended] = await eventStore.appendEvents(newStream(), events.slice(0, 1), {
				expectedVersion: 0,
				pool: unregistered,
			});
			expect(appended.metadata.globalPosition).toBe(3n);
		});

		it('should never reuse the positions of a pool that was dropped and created again', async () => {
			const recreated = uniquePool('recreated');
			const table = track(await eventStore.ensureCollection(recreated));
			await eventStore.appendEvents(newStream(), events.slice(0, 3), { expectedVersion: 0, pool: recreated });
			await pool.query(`DROP TABLE ${escapeIdentifier(table)}`);

			await eventStore.ensureCollection(recreated);
			const [appended] = await eventStore.appendEvents(newStream(), events.slice(0, 1), {
				expectedVersion: 0,
				pool: recreated,
			});
			expect(appended.metadata.globalPosition).toBe(4n);
		});

		it('should append many events at once', async () => {
			const bulk = uniquePool('bulk');
			track(await eventStore.ensureCollection(bulk));
			const many = Array.from({ length: 7_000 }, (_, index) => events[index % events.length]);

			const stream = newStream();
			// More than the 65,535 parameters of a statement would allow with one parameter per value
			const appended = await eventStore.appendEvents(stream, many, { expectedVersion: 0, pool: bulk });

			expect(appended).toHaveLength(many.length);
			expect(appended.at(-1)?.metadata.globalPosition).toBe(7_000n);
			await expect(eventStore.getStreamVersion(stream, bulk)).resolves.toBe(7_000);
		}, 30_000);
	});

	describe('persistence outcome', () => {
		const outcomePool = uniquePool('outcome');
		const outcomeTable = EventCollection.get(outcomePool);

		beforeAll(async () => {
			track(await eventStore.ensureCollection(outcomePool));
		});

		const databaseError = (severity: string, code: string) => {
			const error = new DatabaseError(`${severity} ${code}`, 0, 'error');
			error.severity = severity;
			error.code = code;
			return error;
		};

		/**
		 * Makes the statements of an append that start with `prefix` fail with the given error, leaving the others alone.
		 */
		const failStatement = (prefix: string, error: Error) => {
			const query = Client.prototype.query;
			vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
				if (typeof args[0] === 'string' && args[0].startsWith(prefix)) {
					return Promise.reject(error);
				}
				return query.apply(this, args);
			} as never);
		};

		const append = () =>
			eventStore.appendEvents(newStream(), events.slice(0, 2), { expectedVersion: 0, pool: outcomePool });

		it.each([
			['a check constraint', databaseError('ERROR', '23514')],
			['a deadlock', databaseError('ERROR', '40P01')],
			['a lock timeout', databaseError('ERROR', '55P03')],
			['a cancelled statement', databaseError('ERROR', '57014')],
			['a lost connection', new Error('Connection terminated unexpectedly')],
			['an ended session', databaseError('FATAL', '57P01')],
		])("should report 'not-persisted' when the append statement fails with %s", async (_, cause) => {
			failStatement('WITH counter AS', cause);

			await expect(append()).rejects.toMatchObject({
				code: EventSourcingErrorCode.EventStorePersistence,
				collection: outcomeTable,
				outcome: 'not-persisted',
				cause,
			});
		});

		it("should report 'not-persisted' when BEGIN fails", async () => {
			const cause = new Error('Connection terminated unexpectedly');
			failStatement('BEGIN', cause);

			await expect(append()).rejects.toMatchObject({ outcome: 'not-persisted', cause });
		});

		it("should report 'unknown' when the connection is lost during the COMMIT", async () => {
			const cause = new Error('Connection terminated unexpectedly');
			failStatement('COMMIT', cause);

			await expect(append()).rejects.toMatchObject({ outcome: 'unknown', cause });
		});

		it("should report 'unknown' when the session ends during the COMMIT", async () => {
			const cause = databaseError('FATAL', '57P01');
			failStatement('COMMIT', cause);

			await expect(append()).rejects.toMatchObject({ outcome: 'unknown', cause });
		});

		it("should report 'not-persisted' when the server rejects the COMMIT", async () => {
			const cause = databaseError('ERROR', '40001');
			failStatement('COMMIT', cause);

			await expect(append()).rejects.toMatchObject({ outcome: 'not-persisted', cause });
		});

		// lc_messages translates the severity pg reads: the SQLSTATE tells a rejected statement from an ended session
		it("should report 'not-persisted' when the server rejects the COMMIT in another language", async () => {
			const cause = databaseError('FEHLER', '40001');
			failStatement('COMMIT', cause);

			await expect(append()).rejects.toMatchObject({ outcome: 'not-persisted', cause });
		});

		it("should report 'unknown' when the session ends during the COMMIT in another language", async () => {
			const cause = databaseError('ВАЖНО', '57P01');
			failStatement('COMMIT', cause);

			await expect(append()).rejects.toMatchObject({ outcome: 'unknown', cause });
		});

		it('should roll back and keep the connection when the server rejects a statement in another language', async () => {
			await expect(pool.query('SELECT 1')).resolves.toBeDefined();
			const connections = pool.totalCount;
			failStatement('WITH counter AS', databaseError('ERREUR', '40P01'));

			await expect(append()).rejects.toMatchObject({ outcome: 'not-persisted' });
			expect(pool.totalCount).toBe(connections);
		});

		it("should report 'not-persisted' without a connection when a payload can't be serialized", async () => {
			const begin = vi.spyOn(Client.prototype, 'query');
			const stream = newStream();
			const bigintEnvelope = EventEnvelope.create('account-opened', { amount: 1n } as never, {
				aggregateId: stream.aggregateId,
				version: 1,
			});

			await expect(
				eventStore.appendEvents(stream, [bigintEnvelope], { expectedVersion: 0, pool: outcomePool }),
			).rejects.toMatchObject({ outcome: 'not-persisted', cause: expect.any(TypeError) });
			// Only the version check ran: no transaction was started
			expect(begin.mock.calls.filter(([text]) => String(text).startsWith('BEGIN'))).toEqual([]);
		});

		it("should report 'not-persisted' when no connection can be acquired", async () => {
			const cause = new Error('timeout exceeded when trying to connect');
			const connect = pool.connect;
			// pool.query (the version check) connects with a callback, the append awaits the promise
			vi.spyOn(pool, 'connect').mockImplementation(function (this: Pool, ...args: unknown[]) {
				return args.length > 0 ? connect.apply(this, args as never) : Promise.reject(cause);
			} as never);

			await expect(append()).rejects.toMatchObject({ outcome: 'not-persisted', cause });
		});

		it('should have stored nothing after the failures, and stay usable', async () => {
			const read = await drain(eventStore.readAll({ pool: outcomePool }));
			expect(read).toEqual([]);

			const appended = await append();
			expect(positionsOf(appended)).toEqual([1n, 2n]);
			expect(pool.idleCount).toBe(pool.totalCount);
		});
	});

	describe('collections', () => {
		it('should create a v2 table with a unique index on the positions, and register it', async () => {
			const indexed = uniquePool('index');
			const collection = track(await eventStore.ensureCollection(indexed));

			expect(await getIndexDefinitions(collection)).toEqual([
				`CREATE UNIQUE INDEX "idx_${collection}_global_position" ON "${collection}" USING btree (global_position)`,
				`CREATE UNIQUE INDEX "${collection}_pkey" ON "${collection}" USING btree (stream_id, version)`,
			]);
			const { rows: columns } = await pool.query<{ column_name: string; data_type: string; is_nullable: string }>(
				`SELECT column_name, data_type, is_nullable FROM information_schema.columns
				WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
				[collection],
			);
			expect(
				columns.map(({ column_name, data_type, is_nullable }) => `${column_name} ${data_type} ${is_nullable}`),
			).toEqual([
				'stream_id text NO',
				'version integer NO',
				'event text NO',
				'payload jsonb NO',
				'event_id text NO',
				'aggregate_id text NO',
				'occurred_on timestamp with time zone NO',
				'correlation_id text YES',
				'causation_id text YES',
				'global_position bigint NO',
				'headers jsonb YES',
				'event_version integer YES',
			]);
			expect(await catalogRow(collection)).toEqual({ kind: 'events', schema_version: 2, last_position: '0' });
		});

		it('should derive distinct index names within the identifier limit for long pool names', async () => {
			const suffix = randomUUID().slice(0, 8);
			const longPools = [`pg-${'x'.repeat(38)}-a-${suffix}`, `pg-${'x'.repeat(38)}-b-${suffix}`];
			const collections = await Promise.all(longPools.map((longPool) => eventStore.ensureCollection(longPool)));
			collections.forEach(track);

			const { rows } = await pool.query<{ tablename: string; indexname: string }>(
				`SELECT tablename, indexname FROM pg_indexes
				WHERE schemaname = current_schema() AND tablename = ANY ($1) AND indexdef LIKE '%(global_position)'
				ORDER BY tablename COLLATE "C"`,
				[collections],
			);

			expect(rows.map(({ tablename }) => tablename)).toEqual(collections);
			expect(rows[0].indexname).not.toEqual(rows[1].indexname);
			for (const { indexname } of rows) {
				expect(Buffer.byteLength(indexname)).toBeLessThanOrEqual(63);
			}
		});

		it('should reject a pool whose table name Postgres would truncate, without creating anything', async () => {
			const tooLong = `pg-too-long-${'y'.repeat(60)}`;

			const error = await eventStore.ensureCollection(tooLong).catch((rejection: unknown) => rejection);

			expect(error).toBeInstanceOf(EventStoreCollectionCreationException);
			expect((error as Error).cause).toBeInstanceOf(RangeError);
			const { rows } = await pool.query(`SELECT 1 FROM pg_tables WHERE tablename LIKE $1`, [
				`${tooLong.slice(0, 40)}%`,
			]);
			expect(rows).toEqual([]);
		});

		it('should ensure the same collection concurrently', async () => {
			const race = uniquePool('race');
			const collections = await Promise.all(Array.from({ length: 8 }, () => eventStore.ensureCollection(race)));
			track(EventCollection.get(race));

			expect(new Set(collections)).toEqual(new Set([EventCollection.get(race)]));
			expect(await getIndexDefinitions(EventCollection.get(race))).toHaveLength(2);
		});

		it('should roll back a new collection when its index cannot be created', async () => {
			const failing = uniquePool('index-failure');
			const query = Client.prototype.query;
			vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
				if (typeof args[0] === 'string' && args[0].startsWith('CREATE UNIQUE INDEX')) {
					return Promise.reject(new Error('could not extend file'));
				}
				return query.apply(this, args);
			} as never);

			await expect(eventStore.ensureCollection(failing)).rejects.toThrow(EventStoreCollectionCreationException);
			vi.restoreAllMocks();

			const { rows } = await pool.query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [
				escapeIdentifier(EventCollection.get(failing)),
			]);
			expect(rows).toEqual([{ exists: false }]);
			await expect(catalogRow(EventCollection.get(failing))).resolves.toBeUndefined();
		});

		it('should create the missing position index of an empty v2 table, and only log how to on a filled one', async () => {
			const empty = uniquePool('no-index-empty');
			const filled = uniquePool('no-index-filled');
			for (const noIndex of [empty, filled]) {
				const table = track(await eventStore.ensureCollection(noIndex));
				await pool.query(`DROP INDEX ${escapeIdentifier(`idx_${table}_global_position`)}`);
			}
			await eventStore.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: filled });
			const warn = vi.spyOn(eventStore['logger'], 'warn').mockImplementation(() => undefined);

			await eventStore.ensureCollection(empty);
			await eventStore.ensureCollection(filled);

			expect(await getIndexDefinitions(EventCollection.get(empty))).toHaveLength(2);
			expect(await getIndexDefinitions(EventCollection.get(filled))).toHaveLength(1);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS'));
		});

		it('should support pool names that need quoting', async () => {
			const quotedPool = `pg-quo"te-${randomUUID().slice(0, 8)}`;
			const stream = newStream();

			const collection = track(await eventStore.ensureCollection(quotedPool));
			expect(collection).toBe(`${quotedPool}-events`);
			expect(await getIndexDefinitions(collection)).toHaveLength(2);

			const appended = await eventStore.appendEvents(stream, events.length, events, quotedPool);
			await expect(eventStore.appendEvents(stream, events.length, events, quotedPool)).rejects.toThrow(
				EventStoreVersionConflictException,
			);

			await expect(eventStore.getEvent(stream, 1, quotedPool)).resolves.toEqual(events[0]);
			await expect(eventStore.getEnvelope(stream, 1, quotedPool)).resolves.toEqual(appended[0]);
			expect(await drain(eventStore.getEvents(stream, { pool: quotedPool }))).toEqual(events);
			expect(await drain(eventStore.getEnvelopes(stream, { pool: quotedPool }))).toEqual(appended);
			expect(await drain(eventStore.readAll({ pool: quotedPool }))).toEqual(appended);
			expect(await drain(eventStore.listCollections())).toContain(collection);
		});

		describe("with ddl: 'none'", () => {
			let ddlNone: PostgresEventStore;

			beforeAll(async () => {
				({ store: ddlNone } = createEventStore({ ...connectionOptions, ddl: 'none' }, eventMap));
				await ddlNone.connect();
			});

			afterAll(async () => {
				await ddlNone.disconnect();
			});

			it('should refuse to create a table, and name the statements that do', async () => {
				const absent = uniquePool('ddl-none');
				const table = EventCollection.get(absent);

				const error = (await ddlNone.ensureCollection(absent).catch((rejection: unknown) => rejection)) as
					| EventStoreSchemaException
					| undefined;
				expect(error).toBeInstanceOf(EventStoreSchemaException);
				expect(error).toMatchObject({ collection: table, found: 'missing' });
				expect(error?.remedy).toContain(`CREATE TABLE IF NOT EXISTS ${escapeIdentifier(table)}`);
				await expect(catalogRow(table)).resolves.toBeUndefined();

				// A DBA runs the statements; ensureCollection registers the table with DML only
				const statements = (error?.remedy ?? '').slice(
					(error?.remedy ?? '').indexOf('CREATE TABLE'),
					(error?.remedy ?? '').lastIndexOf(';') + 1,
				);
				await pool.query(statements);
				track(table);
				await expect(ddlNone.ensureCollection(absent)).resolves.toBe(table);
				expect(await catalogRow(table)).toEqual({ kind: 'events', schema_version: 2, last_position: '0' });
				await expect(
					ddlNone.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0, pool: absent }),
				).resolves.toHaveLength(1);
			});

			it.each([
				['a 3.x table', 'v1', ''],
				['a partly migrated table', 'v1-partial', 'ADD COLUMN global_position BIGINT'],
			])('should refuse %s, like with ddl: auto', async (_, found, alter) => {
				const legacy = uniquePool(`ddl-none-${found}`);
				const table = EventCollection.get(legacy);
				await createV1Table(table);
				if (alter) {
					await pool.query(`ALTER TABLE ${escapeIdentifier(table)} ${alter}`);
				}

				await expect(ddlNone.ensureCollection(legacy)).rejects.toMatchObject({
					name: EventStoreSchemaException.name,
					collection: table,
					found,
				});
				await expect(catalogRow(table)).resolves.toBeUndefined();
			});

			it('should heal the position counter of a registered table', async () => {
				const healed = uniquePool('ddl-none-heal');
				const table = track(await eventStore.ensureCollection(healed));
				await eventStore.appendEvents(newStream(), events.slice(0, 3), { expectedVersion: 0, pool: healed });
				await pool.query('UPDATE event_sourcing_collections SET last_position = 1 WHERE name = $1', [table]);

				await expect(ddlNone.ensureCollection(healed)).resolves.toBe(table);

				expect(await catalogRow(table)).toEqual({ kind: 'events', schema_version: 2, last_position: '3' });
			});

			it('should work with only the documented privileges', async () => {
				const schema = `es_pg_privileges_${randomUUID().slice(0, 8)}`;
				const role = schema;
				const password = randomUUID();
				await pool.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
				const inSchema = { ...connectionOptions, options: `-c search_path=${schema}` };
				// Provisioned by the owner: the catalog and the tables of the default pools
				const { store: owner } = createEventStore(inSchema, eventMap);
				const ownerSnapshots = createSnapshotStore(inSchema);
				await owner.connect();
				await ownerSnapshots.connect();
				await owner.ensureCollection();
				await ownerSnapshots.ensureCollection();
				await owner.disconnect();
				await ownerSnapshots.disconnect();

				await pool.query(`CREATE ROLE ${escapeIdentifier(role)} LOGIN PASSWORD ${escapeLiteral(password)}`);
				const s = escapeIdentifier(schema);
				for (const grant of [
					`GRANT USAGE ON SCHEMA ${s} TO ${escapeIdentifier(role)}`,
					`GRANT SELECT, INSERT ON ${s}.events TO ${escapeIdentifier(role)}`,
					`GRANT SELECT, INSERT, UPDATE ON ${s}.snapshots TO ${escapeIdentifier(role)}`,
					`GRANT SELECT, INSERT, UPDATE ON ${s}.event_sourcing_collections TO ${escapeIdentifier(role)}`,
				]) {
					await pool.query(grant);
				}

				const asRole = { ...inSchema, user: role, password };
				const { store } = createEventStore({ ...asRole, ddl: 'none' }, eventMap);
				const { store: autoStore } = createEventStore(asRole, eventMap);
				const snapshots = createSnapshotStore({ ...asRole, ddl: 'none' });
				try {
					await store.connect();
					await autoStore.connect();
					await snapshots.connect();

					await expect(store.ensureCollection()).resolves.toBe('events');
					// ddl: 'auto' on a provisioned schema creates nothing, so it needs no CREATE either
					await expect(autoStore.ensureCollection()).resolves.toBe('events');
					const accountId = AccountId.generate();
					const stream = EventStream.for(Account, accountId);
					await store.appendEvents(stream, events.slice(0, 2), { expectedVersion: ExpectedVersion.NoStream });
					await expect(
						store.appendEvents(stream, events.slice(2, 3), { expectedVersion: ExpectedVersion.NoStream }),
					).rejects.toBeInstanceOf(EventStoreVersionConflictException);
					await store.appendEvents(stream, events.slice(2, 3), { expectedVersion: ExpectedVersion.Any });
					await expect(store.getStreamVersion(stream)).resolves.toBe(3);
					expect(positionsOf(await drain(store.readAll()))).toEqual([1n, 2n, 3n]);
					expect(await drain(store.getEnvelopes(stream))).toHaveLength(3);
					expect(await drain(store.listCollections())).toEqual(['events']);

					await expect(snapshots.ensureCollection()).resolves.toBe('snapshots');
					const snapshotStream = SnapshotStream.for(Account, accountId);
					await snapshots.appendSnapshot(snapshotStream, 2, { balance: 2 });
					const last = await snapshots.appendSnapshot(snapshotStream, 3, { balance: 3 });
					await expect(snapshots.getLastEnvelope(snapshotStream)).resolves.toEqual(last);
					expect(await drain(snapshots.getLastEnvelopesForAggregate(Account))).toEqual([last]);
				} finally {
					await store.disconnect();
					await autoStore.disconnect();
					await snapshots.disconnect();
					await pool.query(`DROP SCHEMA ${s} CASCADE`);
					await pool.query(`DROP OWNED BY ${escapeIdentifier(role)}`);
					await pool.query(`DROP ROLE ${escapeIdentifier(role)}`);
				}
			}, 15_000);

			it('should refuse to create the catalog in a schema without one', async () => {
				const schema = `es_pg_nocatalog_${randomUUID().slice(0, 8)}`;
				await pool.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
				const { store } = createEventStore(
					{ ...connectionOptions, ddl: 'none', options: `-c search_path=${schema}` },
					eventMap,
				);
				try {
					await store.connect();
					const error = (await store.ensureCollection().catch((rejection: unknown) => rejection)) as
						| EventStoreSchemaException
						| undefined;
					expect(error).toBeInstanceOf(EventStoreSchemaException);
					expect(error).toMatchObject({ found: 'missing', collection: 'events' });
					expect(error?.remedy).toContain('CREATE TABLE IF NOT EXISTS event_sourcing_collections');
					const { rows } = await pool.query('SELECT 1 FROM pg_tables WHERE schemaname = $1', [schema]);
					expect(rows).toEqual([]);
				} finally {
					await store.disconnect();
					await pool.query(`DROP SCHEMA ${escapeIdentifier(schema)} CASCADE`);
				}
			});
		});

		it('should create the catalog in a schema without one', async () => {
			const schema = `es_pg_catalog_${randomUUID().slice(0, 8)}`;
			await pool.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
			const { store } = createEventStore({ ...connectionOptions, options: `-c search_path=${schema}` }, eventMap);
			try {
				await store.connect();
				await Promise.all([store.ensureCollection(), store.ensureCollection('other')]);

				const { rows } = await pool.query<{ tablename: string }>(
					'SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename',
					[schema],
				);
				expect(rows.map(({ tablename }) => tablename)).toEqual([
					'event_sourcing_collections',
					'events',
					'other-events',
				]);
				expect(await drain(store.listCollections())).toEqual(['events', 'other-events']);
			} finally {
				await store.disconnect();
				await pool.query(`DROP SCHEMA ${escapeIdentifier(schema)} CASCADE`);
			}
		});

		it('should list nothing without a catalog', async () => {
			const schema = `es_pg_empty_${randomUUID().slice(0, 8)}`;
			await pool.query(`CREATE SCHEMA ${escapeIdentifier(schema)}`);
			const { store } = createEventStore({ ...connectionOptions, options: `-c search_path=${schema}` }, eventMap);
			try {
				await store.connect();
				expect(await drain(store.listCollections())).toEqual([] as IEventCollection[]);
			} finally {
				await store.disconnect();
				await pool.query(`DROP SCHEMA ${escapeIdentifier(schema)} CASCADE`);
			}
		});
	});
});
