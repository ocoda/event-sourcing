import {
	EventCollection,
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
import { type MariaDBEventEntity, MariaDBEventStore } from '@ocoda/event-sourcing-mariadb';
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
import type { Pool } from 'mariadb';

describe(MariaDBEventStore, () => {
	let eventStore: MariaDBEventStore;
	let envelopesAccountA: EventEnvelope[];
	let envelopesAccountB: EventEnvelope[];
	const publish = jest.fn(async () => Promise.resolve());

	let pool: Pool;

	const eventMap = getEventMap();
	const events = getEvents();

	beforeAll(async () => {
		eventStore = new MariaDBEventStore(eventMap, {
			driver: undefined,
			host: '127.0.0.1',
			port: 3306,
			user: 'mariadb',
			password: 'mariadb',
			database: 'mariadb',
		});
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
			pool.query(`DROP TABLE IF EXISTS \`${EventCollection.get()}\``),
			pool.query(`DROP TABLE IF EXISTS \`${EventCollection.get('test-singular-events')}\``),
			pool.query(`DROP TABLE IF EXISTS \`${EventCollection.get('a')}\``),
			pool.query(`DROP TABLE IF EXISTS \`${EventCollection.get('b')}\``),
			pool.query(`DROP TABLE IF EXISTS \`${EventCollection.get('c')}\``),
		]);
		await pool.end();
	});

	it('should append event envelopes', async () => {
		await eventStore.appendEvents(eventStreamAccountA, envelopesAccountA.length, envelopesAccountA);
		await eventStore.appendEvents(eventStreamAccountB, envelopesAccountB.length, envelopesAccountB);

		const entities = await pool.query<MariaDBEventEntity[]>(`
			SELECT * FROM \`${EventCollection.get()}\` ORDER BY version ASC
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

		const entities = await pool.query<MariaDBEventEntity[]>(`
			SELECT * FROM \`${EventCollection.get('test-singular-events')}\` ORDER BY version ASC
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
		expect(eventStore.getEvent(stream, 5)).rejects.toThrow(new EventNotFoundException(stream.streamId, 5));
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
		expect(metadata.eventId).toBeInstanceOf(EventId);
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
			expect(envelope.metadata.eventId).toBeInstanceOf(EventId);
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
});
