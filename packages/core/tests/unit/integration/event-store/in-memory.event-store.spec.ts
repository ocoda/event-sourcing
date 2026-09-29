import { Logger } from '@nestjs/common';
import {
	EventBus,
	type EventEnvelope,
	EventId,
	EventNotFoundException,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	EventStream,
	type IEvent,
	type IEventCollection,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
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
import { type InMemoryEventEntity, InMemoryEventStore } from '@ocoda/event-sourcing/integration/event-store';

describe(InMemoryEventStore, () => {
	let eventStore: InMemoryEventStore;
	let envelopesAccountA: EventEnvelope[];
	let envelopesAccountB: EventEnvelope[];
	const publish = jest.fn(async () => Promise.resolve());

	const eventMap = getEventMap();
	const events = getEvents();

	beforeAll(() => {
		eventStore = new InMemoryEventStore(eventMap, { driver: InMemoryEventStore });
		eventStore.publish = publish;

		eventStore.connect();
		eventStore.ensureCollection();

		envelopesAccountA = getAccountAEventEnvelopes(eventMap, events);
		envelopesAccountB = getAccountBEventEnvelopes(eventMap, events);
	});

	afterAll(() => eventStore.disconnect());

	it('should append event envelopes', async () => {
		await eventStore.appendEvents(eventStreamAccountA, envelopesAccountA.length, envelopesAccountA);
		await eventStore.appendEvents(eventStreamAccountB, envelopesAccountB.length, envelopesAccountB);

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
		}

		for (const [index, entity] of entitiesAccountB.entries()) {
			expect(entity.streamId).toEqual(eventStreamAccountB.streamId);
			expect(entity.event).toEqual(envelopesAccountB[index].event);
			expect(entity.payload).toEqual(envelopesAccountB[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountB[index].metadata.aggregateId);
			expect(entity.eventId).toBeInstanceOf(EventId);
			expect(entity.occurredOn).toEqual(envelopesAccountB[index].metadata.occurredOn);
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

		const entities: InMemoryEventEntity[] = eventStore.collections.get('test-singular-events') || [];

		for (const [index, entity] of entities.entries()) {
			expect(entity.streamId).toEqual(eventStreamAccountC.streamId);
			expect(entity.event).toEqual(envelopesAccountC[index].event);
			expect(entity.payload).toEqual(envelopesAccountC[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountC[index].metadata.aggregateId);
			expect(entity.eventId).toBeInstanceOf(EventId);
			expect(entity.occurredOn).toBeInstanceOf(Date);
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

	it('should throw when the first appended version already exists in the stream', async () => {
		const pool = 'overlapping-appends';
		const stream = EventStream.for(Account, AccountId.generate());

		await eventStore.ensureCollection(pool);
		await eventStore.appendEvents(stream, 3, events.slice(0, 3), pool);

		// Two events appended at version 4 take versions 3 and 4, and version 3 exists already
		await expect(eventStore.appendEvents(stream, 4, events.slice(3, 5), pool)).rejects.toThrow(
			new EventStoreVersionConflictException(stream, 4, 3),
		);

		const versions = (eventStore.collections.get(`${pool}-events`) || [])
			.filter(({ streamId }) => streamId === stream.streamId)
			.map(({ version }) => version);
		expect(versions).toEqual([1, 2, 3]);
	});

	it("should throw when event envelopes can't be appended", async () => {
		await expect(eventStore.appendEvents(eventStreamAccountA, 3, events.slice(0, 3), 'not-a-pool')).rejects.toThrow(
			EventStorePersistenceException,
		);
	});

	it('should retrieve a single event from a specified stream', () => {
		const resolvedEvent = eventStore.getEvent(eventStreamAccountA, envelopesAccountA[3].metadata.version);

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
		for await (const events of eventStore.getEvents(eventStreamAccountA, { fromVersion: 3 })) {
			resolvedEvents.push(...events);
		}

		expect(resolvedEvents).toEqual(events.slice(2));
	});

	it("should throw when an event isn't found in a specified stream", () => {
		const stream = EventStream.for(Account, AccountId.generate());
		expect(() => eventStore.getEvent(stream, 5)).toThrow(new EventNotFoundException(stream.streamId, 5));
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
		for await (const events of eventStore.getEvents(eventStreamAccountA, { limit: 3 })) {
			resolvedEvents.push(...events);
		}

		expect(resolvedEvents).toEqual(events.slice(0, 3));
	});

	it('should batch the returned events', async () => {
		const resolvedEvents: IEvent[] = [];
		for await (const events of eventStore.getEvents(eventStreamAccountA, { batch: 2 })) {
			expect(events.length).toBe(2);
			resolvedEvents.push(...events);
		}

		expect(resolvedEvents).toEqual(events);
	});

	it('should retrieve a single event-envelope', () => {
		const { event, metadata, payload } = eventStore.getEnvelope(
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

	it('should retrieve all event-envelopes until a given date', async () => {
		const resolvedAllEnvelopes: EventEnvelope[] = [];
		for await (const envelopes of eventStore.getAllEnvelopes({
			since: { year: 2021, month: 1 },
			until: { year: 2021, month: 3 },
		})) {
			resolvedAllEnvelopes.push(...envelopes);
		}

		expect(resolvedAllEnvelopes.length).toBeGreaterThan(0);
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
});

describe(`${InMemoryEventStore.name} lifecycle and publishing`, () => {
	const eventMap = getEventMap();
	const events = getEvents();

	let eventStore: InMemoryEventStore;
	let loggerWarn: jest.SpyInstance;
	let loggerError: jest.SpyInstance;

	beforeEach(async () => {
		jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
		loggerWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
		loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

		eventStore = new InMemoryEventStore(eventMap, { driver: InMemoryEventStore });
		await eventStore.connect();
		await eventStore.ensureCollection();
	});

	afterEach(async () => {
		await eventStore.disconnect();
		jest.restoreAllMocks();
	});

	it('does not throw when disconnecting before connecting', async () => {
		const unconnectedStore = new InMemoryEventStore(eventMap, { driver: InMemoryEventStore });

		await expect(unconnectedStore.disconnect()).resolves.toBeUndefined();
	});

	it('does not wipe existing events when ensuring an existing collection', async () => {
		eventStore.publish = jest.fn();
		const stream = EventStream.for(Account, AccountId.generate());

		await eventStore.ensureCollection('tenant-1');
		await eventStore.appendEvents(stream, 2, events.slice(0, 2), 'tenant-1');
		await eventStore.appendEvents(stream, 2, events.slice(0, 2));

		await expect(eventStore.ensureCollection('tenant-1')).resolves.toBe('tenant-1-events');
		await expect(eventStore.ensureCollection()).resolves.toBe('events');

		expect(eventStore.collections.get('tenant-1-events')).toHaveLength(2);
		expect(eventStore.collections.get('events')).toHaveLength(2);
		expect(eventStore.getEvent(stream, 2, 'tenant-1')).toEqual(events[1]);
	});

	it('persists and returns the envelopes when events are appended before a publish function is set', async () => {
		const stream = EventStream.for(Account, AccountId.generate());

		const firstEnvelopes = await eventStore.appendEvents(stream, 2, events.slice(0, 2));
		const secondEnvelopes = await eventStore.appendEvents(stream, 3, events.slice(2, 3));

		expect(firstEnvelopes.map(({ metadata }) => metadata.version)).toEqual([1, 2]);
		expect(secondEnvelopes.map(({ metadata }) => metadata.version)).toEqual([3]);
		expect(eventStore.collections.get('events')).toHaveLength(3);

		// the missing publisher is only reported once per store
		expect(loggerWarn).toHaveBeenCalledTimes(1);
		expect(loggerWarn).toHaveBeenCalledWith(
			'Events were appended before a publish function was set on the event store (is the application bootstrapped?). They were persisted but not published.',
		);
	});

	it('does not reject the append nor skip the remaining envelopes when publishing fails', async () => {
		const publish = jest
			.fn()
			.mockImplementationOnce(() => {
				throw new Error('sync publish failure');
			})
			.mockImplementationOnce(() => Promise.reject(new Error('async publish failure')))
			.mockImplementation(() => undefined);
		eventStore.publish = publish;
		const stream = EventStream.for(Account, AccountId.generate());

		const envelopes = await eventStore.appendEvents(stream, 3, events.slice(0, 3));

		expect(envelopes).toHaveLength(3);
		expect(eventStore.collections.get('events')).toHaveLength(3);
		expect(publish.mock.calls).toEqual(envelopes.map((envelope) => [envelope]));

		expect(loggerError).toHaveBeenCalledTimes(2);
		expect(loggerError).toHaveBeenNthCalledWith(
			1,
			`Failed to publish event "${envelopes[0].event}" after it was appended`,
			expect.stringContaining('sync publish failure'),
		);
		expect(loggerError).toHaveBeenNthCalledWith(
			2,
			`Failed to publish event "${envelopes[1].event}" after it was appended`,
			expect.stringContaining('async publish failure'),
		);
	});

	it('isolates failing event publishers when wired to the event bus', async () => {
		const eventBus = new EventBus();
		const rejectingPublisher = { publish: jest.fn(() => Promise.reject(new Error('broker unavailable'))) };
		const throwingPublisher = {
			publish: jest.fn(() => {
				throw new Error('broker misconfigured');
			}),
		};
		const healthyPublisher = { publish: jest.fn() };
		const subscriber = { handle: jest.fn() };

		eventBus.addPublisher(rejectingPublisher);
		eventBus.addPublisher(throwingPublisher);
		eventBus.addPublisher(healthyPublisher);
		eventBus.bind(subscriber, '');
		eventStore.publish = eventBus.publish;

		const stream = EventStream.for(Account, AccountId.generate());
		const envelopes = await eventStore.appendEvents(stream, 2, events.slice(0, 2));
		await new Promise((resolve) => setTimeout(resolve, 10));

		const expectedCalls = envelopes.map((envelope) => [envelope]);
		expect(rejectingPublisher.publish.mock.calls).toEqual(expectedCalls);
		expect(throwingPublisher.publish.mock.calls).toEqual(expectedCalls);
		expect(healthyPublisher.publish.mock.calls).toEqual(expectedCalls);
		expect(subscriber.handle.mock.calls).toEqual(expectedCalls);
		expect(eventStore.collections.get('events')).toHaveLength(2);
		// 2 envelopes x 2 failing publishers
		expect(loggerError).toHaveBeenCalledTimes(4);
	});

	it('includes the events of the current UTC month when no until date is given', async () => {
		// 2024-02-01T00:30Z is still January in a UTC-10 timezone (e.g. Pacific/Honolulu)
		jest.useFakeTimers({
			now: new Date('2024-02-01T00:30:00Z'),
			doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
		});
		const shift = (date: Date) => new Date(date.getTime() - 10 * 60 * 60 * 1000);
		jest.spyOn(Date.prototype, 'getFullYear').mockImplementation(function (this: Date) {
			return shift(this).getUTCFullYear();
		});
		jest.spyOn(Date.prototype, 'getMonth').mockImplementation(function (this: Date) {
			return shift(this).getUTCMonth();
		});

		try {
			eventStore.publish = jest.fn();
			const stream = EventStream.for(Account, AccountId.generate());
			await eventStore.appendEvents(stream, 1, events.slice(0, 1));

			const resolvedEnvelopes: EventEnvelope[] = [];
			for await (const envelopes of eventStore.getAllEnvelopes({ since: { year: 2024, month: 1 } })) {
				resolvedEnvelopes.push(...envelopes);
			}

			expect(resolvedEnvelopes).toHaveLength(1);
			expect(resolvedEnvelopes[0].metadata.occurredOn).toEqual(new Date('2024-02-01T00:30:00Z'));
		} finally {
			jest.useRealTimers();
		}
	});
});
