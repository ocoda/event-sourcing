import { Logger } from '@nestjs/common';
import {
	EventBus,
	EventCollectionNotFoundException,
	type EventEnvelope,
	EventId,
	EventNotFoundException,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	EventStream,
	ExpectedVersion,
	type IEvent,
	type IEventCollection,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import {
	Account,
	AccountId,
	createTestContext,
	eventStreamAccountA,
	eventStreamAccountB,
	getAccountAEventEnvelopes,
	getAccountBEventEnvelopes,
	getAccountEventEnvelopes,
	getEventMap,
	getEvents,
} from '@ocoda/event-sourcing-testing/unit';
import { type InMemoryEventEntity, InMemoryEventStore } from '@ocoda/event-sourcing/integration/event-store';
import type { MockInstance } from 'vitest';

const drain = async <T>(generator: AsyncGenerator<T[]>): Promise<T[]> => {
	const items: T[] = [];
	for await (const batch of generator) {
		items.push(...batch);
	}
	return items;
};

const newStream = () => EventStream.for(Account, AccountId.generate());

describe(InMemoryEventStore, () => {
	let eventStore: InMemoryEventStore;
	let envelopesAccountA: EventEnvelope[];
	let envelopesAccountB: EventEnvelope[];
	const publish = vi.fn(async (_envelope: EventEnvelope) => undefined);

	const eventMap = getEventMap();
	const events = getEvents();

	beforeAll(async () => {
		eventStore = new InMemoryEventStore(createTestContext(eventMap, publish), { driver: InMemoryEventStore });

		await eventStore.connect();
		await eventStore.ensureCollection();

		envelopesAccountA = getAccountAEventEnvelopes(eventMap, events);
		envelopesAccountB = getAccountBEventEnvelopes(eventMap, events);
	});

	afterAll(() => eventStore.disconnect());

	it('claims atomic appends, headers and a gap-safe global order', () => {
		expect(eventStore.capabilities).toEqual({ atomicAppend: true, headers: true, globalOrder: 'gap-safe' });
	});

	it('should append event envelopes', async () => {
		await eventStore.appendEvents(eventStreamAccountA, envelopesAccountA, {
			expectedVersion: ExpectedVersion.NoStream,
		});
		await eventStore.appendEvents(eventStreamAccountB, envelopesAccountB, {
			expectedVersion: ExpectedVersion.NoStream,
		});

		const entities: InMemoryEventEntity[] = eventStore.collections.get('events') || [];
		const entitiesAccountA = entities.filter(
			({ streamId: entityStreamId }) => entityStreamId === eventStreamAccountA.streamId,
		);
		const entitiesAccountB = entities.filter(
			({ streamId: entityStreamId }) => entityStreamId === eventStreamAccountB.streamId,
		);

		expect(entities).toHaveLength(events.length * 2);
		expect(entitiesAccountA).toHaveLength(events.length);
		expect(entitiesAccountB).toHaveLength(events.length);

		for (const [index, entity] of entitiesAccountA.entries()) {
			expect(entity.streamId).toEqual(eventStreamAccountA.streamId);
			expect(entity.event).toEqual(envelopesAccountA[index].event);
			expect(entity.payload).toEqual(envelopesAccountA[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(entity.eventId).toBeInstanceOf(EventId);
			expect(entity.occurredOn).toEqual(envelopesAccountA[index].metadata.occurredOn);
			expect(entity.version).toEqual(envelopesAccountA[index].metadata.version);
			expect(entity.globalPosition).toBe(BigInt(index + 1));
		}

		for (const [index, entity] of entitiesAccountB.entries()) {
			expect(entity.streamId).toEqual(eventStreamAccountB.streamId);
			expect(entity.event).toEqual(envelopesAccountB[index].event);
			expect(entity.payload).toEqual(envelopesAccountB[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountB[index].metadata.aggregateId);
			expect(entity.eventId).toBeInstanceOf(EventId);
			expect(entity.occurredOn).toEqual(envelopesAccountB[index].metadata.occurredOn);
			expect(entity.version).toEqual(envelopesAccountB[index].metadata.version);
			expect(entity.globalPosition).toBe(BigInt(events.length + index + 1));
		}

		expect(publish).toHaveBeenCalledTimes(events.length * 2);
	});

	it('should append events', async () => {
		const accountId = AccountId.generate();
		const eventStreamAccountC = EventStream.for(Account, accountId);
		const envelopesAccountC = getAccountEventEnvelopes(accountId, eventMap, events);

		await eventStore.ensureCollection('test-singular-events');
		await eventStore.appendEvents(eventStreamAccountC, events, {
			expectedVersion: ExpectedVersion.NoStream,
			pool: 'test-singular-events',
		});

		const entities: InMemoryEventEntity[] = eventStore.collections.get('test-singular-events-events') || [];

		expect(entities).toHaveLength(events.length);
		for (const [index, entity] of entities.entries()) {
			expect(entity.streamId).toEqual(eventStreamAccountC.streamId);
			expect(entity.event).toEqual(envelopesAccountC[index].event);
			expect(entity.payload).toEqual(envelopesAccountC[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountC[index].metadata.aggregateId);
			expect(entity.eventId).toBeInstanceOf(EventId);
			expect(entity.occurredOn).toBeInstanceOf(Date);
			expect(entity.version).toEqual(envelopesAccountC[index].metadata.version);
			// Positions are per pool
			expect(entity.globalPosition).toBe(BigInt(index + 1));
		}
	});

	it('should throw when trying to append an event to a stream that has a version lower or equal to the latest event for that stream', async () => {
		const lastEvent = events[events.length - 1];
		const lastVersion = events.length;
		const beforeLastVersion = lastVersion - 1;
		await expect(eventStore.appendEvents(eventStreamAccountA, beforeLastVersion, [lastEvent])).rejects.toThrow(
			new EventStoreVersionConflictException({
				stream: eventStreamAccountA,
				expectedVersion: beforeLastVersion - 1,
				actualVersion: lastVersion,
			}),
		);
		await expect(eventStore.appendEvents(eventStreamAccountA, lastVersion, [lastEvent])).rejects.toThrow(
			new EventStoreVersionConflictException({
				stream: eventStreamAccountA,
				expectedVersion: lastVersion - 1,
				actualVersion: lastVersion,
			}),
		);
	});

	it("should throw when event envelopes can't be appended", async () => {
		const error = await eventStore
			.appendEvents(eventStreamAccountA, events.slice(0, 3), {
				expectedVersion: ExpectedVersion.NoStream,
				pool: 'not-a-pool',
			})
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(EventStorePersistenceException);
		expect(error).toMatchObject({ collection: 'not-a-pool-events', outcome: 'not-persisted' });
		expect((error as Error).cause).toBeInstanceOf(EventCollectionNotFoundException);
		expect(eventStore.collections.has('not-a-pool-events')).toBe(false);
	});

	it('should retrieve a single event from a specified stream', async () => {
		const resolvedEvent = await eventStore.getEvent(eventStreamAccountA, envelopesAccountA[3].metadata.version);

		expect(resolvedEvent).toEqual(events[3]);
	});

	it('should filter events by stream', async () => {
		expect(await drain(eventStore.getEvents(eventStreamAccountA))).toEqual(events);
	});

	it('should filter events by stream and version', async () => {
		expect(await drain(eventStore.getEvents(eventStreamAccountA, { fromVersion: 3 }))).toEqual(events.slice(2));
	});

	it("should throw when an event isn't found in a specified stream", async () => {
		const stream = newStream();
		await expect(eventStore.getEvent(stream, 5)).rejects.toThrow(
			new EventNotFoundException({ streamId: stream.streamId, version: 5 }),
		);
	});

	it('should retrieve events backwards', async () => {
		expect(
			await drain(eventStore.getEvents(eventStreamAccountA, { direction: StreamReadingDirection.BACKWARD })),
		).toEqual(events.slice().reverse());
	});

	it('should retrieve events backwards from a certain version', async () => {
		expect(
			await drain(
				eventStore.getEvents(eventStreamAccountA, { fromVersion: 4, direction: StreamReadingDirection.BACKWARD }),
			),
		).toEqual(events.slice(3).reverse());
	});

	it('should limit the returned events', async () => {
		expect(await drain(eventStore.getEvents(eventStreamAccountA, { limit: 3 }))).toEqual(events.slice(0, 3));
	});

	it('should batch the returned events', async () => {
		const resolvedEvents: IEvent[] = [];
		for await (const batch of eventStore.getEvents(eventStreamAccountA, { batch: 2 })) {
			expect(batch.length).toBe(2);
			resolvedEvents.push(...batch);
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
		expect(metadata.globalPosition).toBe(4n);
	});

	it('should retrieve event-envelopes', async () => {
		const resolvedEnvelopes = await drain(eventStore.getEnvelopes(eventStreamAccountA));

		expect(resolvedEnvelopes).toHaveLength(envelopesAccountA.length);

		for (const [index, envelope] of resolvedEnvelopes.entries()) {
			expect(envelope.event).toEqual(envelopesAccountA[index].event);
			expect(envelope.payload).toEqual(envelopesAccountA[index].payload);
			expect(envelope.metadata.aggregateId).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(envelope.metadata.occurredOn).toBeInstanceOf(Date);
			expect(envelope.metadata.version).toEqual(envelopesAccountA[index].metadata.version);
			expect(envelope.metadata.globalPosition).toBe(BigInt(index + 1));
		}
	});

	it('should read all envelopes of a pool in the order they were appended', async () => {
		const resolved = await drain(eventStore.readAll());

		expect(resolved.map(({ metadata }) => metadata.eventId.value)).toEqual(
			[...envelopesAccountA, ...envelopesAccountB].map(({ metadata }) => metadata.eventId.value),
		);
		expect(resolved.map(({ metadata }) => metadata.globalPosition)).toEqual(
			resolved.map((_, index) => BigInt(index + 1)),
		);
	});

	it('should read all envelopes from a position, in batches', async () => {
		const batches: EventEnvelope[][] = [];
		for await (const batch of eventStore.readAll({ fromPosition: 5n, batch: 3 })) {
			batches.push(batch);
		}

		expect(batches.map((batch) => batch.map(({ metadata }) => metadata.globalPosition))).toEqual([
			[5n, 6n, 7n],
			[8n, 9n, 10n],
			[11n, 12n],
		]);
	});

	it('should list collections', async () => {
		await Promise.all([
			eventStore.ensureCollection('a'),
			eventStore.ensureCollection('b'),
			eventStore.ensureCollection('c'),
		]);

		const resolvedCollections: IEventCollection[] = await drain(eventStore.listCollections());

		expect(resolvedCollections.includes('a-events')).toBe(true);
		expect(resolvedCollections.includes('b-events')).toBe(true);
		expect(resolvedCollections.includes('c-events')).toBe(true);
	});
});

describe(`${InMemoryEventStore.name} lifecycle, reads and publishing`, () => {
	const eventMap = getEventMap();
	const events = getEvents();

	let eventStore: InMemoryEventStore;
	let loggerError: MockInstance;

	beforeEach(async () => {
		vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
		loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

		eventStore = new InMemoryEventStore(createTestContext(eventMap), { driver: InMemoryEventStore });
		await eventStore.connect();
		await eventStore.ensureCollection();
	});

	afterEach(async () => {
		await eventStore.disconnect();
		vi.restoreAllMocks();
	});

	it('does not throw when disconnecting before connecting', async () => {
		const unconnectedStore = new InMemoryEventStore(createTestContext(eventMap), { driver: InMemoryEventStore });

		await expect(unconnectedStore.disconnect()).resolves.toBeUndefined();
		await expect(drain(unconnectedStore.listCollections())).resolves.toEqual([]);
	});

	it('does not wipe existing events when ensuring an existing collection', async () => {
		const stream = newStream();

		await eventStore.ensureCollection('tenant-1');
		await eventStore.appendEvents(stream, 2, events.slice(0, 2), 'tenant-1');
		await eventStore.appendEvents(stream, 2, events.slice(0, 2));

		await expect(eventStore.ensureCollection('tenant-1')).resolves.toBe('tenant-1-events');
		await expect(eventStore.ensureCollection()).resolves.toBe('events');

		expect(eventStore.collections.get('tenant-1-events')).toHaveLength(2);
		expect(eventStore.collections.get('events')).toHaveLength(2);
		await expect(eventStore.getEvent(stream, 2, 'tenant-1')).resolves.toEqual(events[1]);
	});

	it('forgets the events and restarts the positions when connecting again', async () => {
		await eventStore.appendEvents(newStream(), events.slice(0, 2), { expectedVersion: ExpectedVersion.NoStream });

		await eventStore.connect();
		await eventStore.ensureCollection();
		const [envelope] = await eventStore.appendEvents(newStream(), events.slice(0, 1), {
			expectedVersion: ExpectedVersion.NoStream,
		});

		expect(envelope.metadata.globalPosition).toBe(1n);
		expect(eventStore.collections.get('events')).toHaveLength(1);
	});

	it('throws an EventCollectionNotFoundException from every read of an unknown pool', async () => {
		const stream = newStream();
		const pool = 'unknown';

		await expect(eventStore.getStreamVersion(stream, pool)).rejects.toBeInstanceOf(EventCollectionNotFoundException);
		await expect(eventStore.getEnvelope(stream, 1, pool)).rejects.toBeInstanceOf(EventCollectionNotFoundException);
		await expect(eventStore.getEvent(stream, 1, pool)).rejects.toBeInstanceOf(EventCollectionNotFoundException);
		await expect(drain(eventStore.getEnvelopes(stream, { pool }))).rejects.toBeInstanceOf(
			EventCollectionNotFoundException,
		);
		await expect(drain(eventStore.getEvents(stream, { pool }))).rejects.toBeInstanceOf(
			EventCollectionNotFoundException,
		);
		await expect(drain(eventStore.readAll({ pool }))).rejects.toMatchObject({
			collection: 'unknown-events',
			pool,
		});
	});

	it('reads the version of a stream', async () => {
		const stream = newStream();
		await expect(eventStore.getStreamVersion(stream)).resolves.toBe(0);

		await eventStore.appendEvents(stream, events.slice(0, 3), { expectedVersion: ExpectedVersion.NoStream });

		await expect(eventStore.getStreamVersion(stream)).resolves.toBe(3);
		await expect(eventStore.getStreamVersion(newStream())).resolves.toBe(0);
	});

	it('reads the events appended while reading all', async () => {
		await eventStore.appendEvents(newStream(), events.slice(0, 2), { expectedVersion: ExpectedVersion.NoStream });

		const positions: bigint[] = [];
		for await (const batch of eventStore.readAll({ batch: 2 })) {
			positions.push(...batch.map(({ metadata }) => metadata.globalPosition as bigint));
			if (positions.length === 2) {
				await eventStore.appendEvents(newStream(), events.slice(0, 3), { expectedVersion: ExpectedVersion.NoStream });
			}
		}

		expect(positions).toEqual([1n, 2n, 3n, 4n, 5n]);
	});

	it('reads all from a position given as a number, and rejects an invalid one', async () => {
		await eventStore.appendEvents(newStream(), events.slice(0, 3), { expectedVersion: ExpectedVersion.NoStream });

		const fromNumber = await drain(eventStore.readAll({ fromPosition: 2 as unknown as bigint }));
		expect(fromNumber.map(({ metadata }) => metadata.globalPosition)).toEqual([2n, 3n]);
		await expect(drain(eventStore.readAll({ fromPosition: -1n }))).rejects.toThrow(RangeError);
	});

	it('rejects a batch size that is not a positive integer, rather than stopping early', async () => {
		await eventStore.appendEvents(newStream(), events.slice(0, 3), { expectedVersion: ExpectedVersion.NoStream });

		for (const batch of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2' as unknown as number]) {
			await expect(drain(eventStore.readAll({ batch })), `batch ${String(batch)}`).rejects.toThrow(
				`Not a batch size: ${String(batch)}`,
			);
		}
		const sizes: number[] = [];
		for await (const batch of eventStore.readAll({ batch: 1 })) {
			sizes.push(batch.length);
		}
		expect(sizes).toEqual([1, 1, 1]);
		expect(await drain(eventStore.readAll({ batch: undefined }))).toHaveLength(3);
	});

	it('stores headers and the event version, as a copy of the appended headers', async () => {
		const stream = newStream();
		const headers = { tenant: 'acme' };

		const [appended] = await eventStore.appendEvents(stream, events.slice(0, 1), {
			expectedVersion: ExpectedVersion.NoStream,
			metadata: { headers, correlationId: 'correlation', causationId: 'causation' },
		});
		(headers as Record<string, string>).tenant = 'changed';

		const read = await eventStore.getEnvelope(stream, 1);
		expect(read.metadata).toEqual({
			eventId: appended.metadata.eventId,
			aggregateId: stream.aggregateId,
			version: 1,
			occurredOn: appended.metadata.occurredOn,
			correlationId: 'correlation',
			causationId: 'causation',
			headers: { tenant: 'acme' },
			globalPosition: 1n,
		});
		expect(Object.isFrozen(read.metadata.headers)).toBe(true);
	});

	it('reports a taken version as a conflict with the version of the stream and a cause', async () => {
		const stream = newStream();
		await eventStore.appendEvents(stream, events.slice(0, 2), { expectedVersion: ExpectedVersion.NoStream });
		vi.spyOn(eventStore, 'getStreamVersion').mockResolvedValueOnce(1);

		const error = await eventStore
			.appendEvents(stream, events.slice(1, 2), { expectedVersion: 1 })
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(EventStoreVersionConflictException);
		expect(error).toMatchObject({ expectedVersion: 1, actualVersion: 2 });
		expect((error as Error).cause).toEqual(new Error(`Duplicate key (${stream.streamId}, 2) in the events collection`));
	});

	it('does not reject the append when publishing fails', async () => {
		const publishAll = vi.fn().mockRejectedValue(new Error('publish failure'));
		const store = new InMemoryEventStore({ eventMap, publisher: { publishAll } }, { driver: InMemoryEventStore });
		await store.connect();
		await store.ensureCollection();

		const envelopes = await store.appendEvents(newStream(), 3, events.slice(0, 3));

		expect(envelopes).toHaveLength(3);
		expect(store.collections.get('events')).toHaveLength(3);
		expect(publishAll).toHaveBeenCalledWith(envelopes);
		expect(loggerError).toHaveBeenCalledTimes(1);
		expect(loggerError).toHaveBeenCalledWith(
			'Failed to publish 3 appended event(s)',
			expect.stringContaining('publish failure'),
		);
	});

	it('isolates failing event publishers when wired to the event bus', async () => {
		const eventBus = new EventBus();
		const rejectingPublisher = { publish: vi.fn(() => Promise.reject(new Error('broker unavailable'))) };
		const throwingPublisher = {
			publish: vi.fn(() => {
				throw new Error('broker misconfigured');
			}),
		};
		const healthyPublisher = { publish: vi.fn() };
		const subscriber = { handle: vi.fn() };

		eventBus.addPublisher(rejectingPublisher);
		eventBus.addPublisher(throwingPublisher);
		eventBus.addPublisher(healthyPublisher);
		eventBus.bind(subscriber, '');
		const store = new InMemoryEventStore({ eventMap, publisher: eventBus }, { driver: InMemoryEventStore });
		await store.connect();
		await store.ensureCollection();

		const envelopes = await store.appendEvents(newStream(), 2, events.slice(0, 2));
		await new Promise((resolve) => setTimeout(resolve, 10));

		const expectedCalls = envelopes.map((envelope) => [envelope]);
		expect(rejectingPublisher.publish.mock.calls).toEqual(expectedCalls);
		expect(throwingPublisher.publish.mock.calls).toEqual(expectedCalls);
		expect(healthyPublisher.publish.mock.calls).toEqual(expectedCalls);
		expect(subscriber.handle.mock.calls).toEqual(expectedCalls);
		expect(store.collections.get('events')).toHaveLength(2);
		// 2 envelopes x 2 failing publishers
		expect(loggerError).toHaveBeenCalledTimes(4);
	});
});
