import {
	type EventEnvelope,
	EventNotFoundException,
	EventStorePersistenceException,
	EventStoreVersionConflictException,
	EventStream,
	type IEvent,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import {
	Account,
	AccountId,
	eventStreamAccountA,
	eventStreamAccountB,
	getAccountAEventEnvelopes,
	getAccountBEventEnvelopes,
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
		eventStore = new InMemoryEventStore(eventMap, { driver: undefined });
		eventStore.publish = publish;

		eventStore.connect();
		eventStore.ensureCollection();

		envelopesAccountA = getAccountAEventEnvelopes(eventMap, events);
		envelopesAccountB = getAccountBEventEnvelopes(eventMap, events);
	});

	afterAll(() => eventStore.disconnect());

	it('should append event envelopes', async () => {
		await eventStore.appendEvents(eventStreamAccountA, 3, events.slice(0, 3));
		await eventStore.appendEvents(eventStreamAccountB, 3, events.slice(0, 3));
		await eventStore.appendEvents(eventStreamAccountA, 6, events.slice(3));
		await eventStore.appendEvents(eventStreamAccountB, 6, events.slice(3));

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
			expect(entity.occurredOn).toBeInstanceOf(Date);
			expect(entity.version).toEqual(envelopesAccountA[index].metadata.version);
		}

		for (const [index, entity] of entitiesAccountB.entries()) {
			expect(entity.streamId).toEqual(eventStreamAccountB.streamId);
			expect(entity.event).toEqual(envelopesAccountB[index].event);
			expect(entity.payload).toEqual(envelopesAccountB[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountB[index].metadata.aggregateId);
			expect(entity.occurredOn).toBeInstanceOf(Date);
			expect(entity.version).toEqual(envelopesAccountB[index].metadata.version);
		}

		expect(publish).toHaveBeenCalledTimes(events.length * 2);
	});

	it('should throw when trying to append an event to a stream that has a version lower or equal to the latest event for that stream', async () => {
		const lastEvent = events[events.length - 1];
		const lastVersion = events.length;
		const beforeLastVersion = lastVersion - 1;
		expect(eventStore.appendEvents(eventStreamAccountA, beforeLastVersion, [lastEvent])).rejects.toThrow(
			new EventStoreVersionConflictException(eventStreamAccountA, beforeLastVersion, lastVersion),
		);
		expect(eventStore.appendEvents(eventStreamAccountA, lastVersion, [lastEvent])).rejects.toThrow(
			new EventStoreVersionConflictException(eventStreamAccountA, lastVersion, lastVersion),
		);
	});

	it("should throw when event envelopes can't be appended", async () => {
		expect(() => eventStore.appendEvents(eventStreamAccountA, 3, events.slice(0, 3), 'not-a-pool')).rejects.toThrow(
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
});
