import { DeleteTableCommand, type DynamoDBClient, QueryCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { EventCollection, EventStoreVersionConflictException, type IEvent } from '@ocoda/event-sourcing';
import {
	type EventEnvelope,
	EventNotFoundException,
	EventStorePersistenceException,
	EventStream,
	StreamReadingDirection,
} from '@ocoda/event-sourcing';
import { DynamoDBEventStore } from '@ocoda/event-sourcing-dynamodb';
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

describe(DynamoDBEventStore, () => {
	let eventStore: DynamoDBEventStore;
	let envelopesAccountA: EventEnvelope[];
	let envelopesAccountB: EventEnvelope[];
	const publish = jest.fn(async () => Promise.resolve());

	let client: DynamoDBClient;

	const eventMap = getEventMap();
	const events = getEvents();

	beforeAll(async () => {
		eventStore = new DynamoDBEventStore(eventMap, {
			driver: undefined,
			region: 'us-east-1',
			endpoint: 'http://127.0.0.1:8000',
			credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
		});
		eventStore.publish = publish;

		await eventStore.connect();
		await eventStore.ensureCollection();

		envelopesAccountA = getAccountAEventEnvelopes(eventMap, events);
		envelopesAccountB = getAccountBEventEnvelopes(eventMap, events);

		// biome-ignore lint/complexity/useLiteralKeys: Needed to check the internal workings of the event store
		client = eventStore['client'];
	});

	afterAll(async () => {
		await client.send(new DeleteTableCommand({ TableName: EventCollection.get() }));
		client.destroy();
	});

	it('should append event envelopes', async () => {
		await eventStore.appendEvents(eventStreamAccountA, 3, events.slice(0, 3));
		await eventStore.appendEvents(eventStreamAccountB, 3, events.slice(0, 3));
		await eventStore.appendEvents(eventStreamAccountA, 6, events.slice(3));
		await eventStore.appendEvents(eventStreamAccountB, 6, events.slice(3));

		const { Items: itemsAccountA } = await client.send(
			new QueryCommand({
				TableName: EventCollection.get(),
				KeyConditionExpression: 'streamId = :streamId',
				ExpressionAttributeValues: {
					':streamId': { S: eventStreamAccountA.streamId },
				},
			}),
		);
		const entitiesAccountA = itemsAccountA?.map((item) => unmarshall(item)) || [];

		const { Items: itemsAccountB } = await client.send(
			new QueryCommand({
				TableName: EventCollection.get(),
				KeyConditionExpression: 'streamId = :streamId',
				ExpressionAttributeValues: {
					':streamId': { S: eventStreamAccountB.streamId },
				},
			}),
		);
		const entitiesAccountB = itemsAccountB?.map((item) => unmarshall(item)) || [];

		expect(entitiesAccountA).toHaveLength(events.length);
		expect(entitiesAccountB).toHaveLength(events.length);

		for (const [index, entity] of entitiesAccountA.entries()) {
			expect(entity.streamId).toEqual(eventStreamAccountA.streamId);
			expect(entity.event).toEqual(envelopesAccountA[index].event);
			expect(entity.payload).toEqual(envelopesAccountA[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(typeof entity.occurredOn).toBe('number');
			expect(entity.version).toEqual(envelopesAccountA[index].metadata.version);
		}

		for (const [index, entity] of entitiesAccountB.entries()) {
			expect(entity.streamId).toEqual(eventStreamAccountB.streamId);
			expect(entity.event).toEqual(envelopesAccountB[index].event);
			expect(entity.payload).toEqual(envelopesAccountB[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountB[index].metadata.aggregateId);
			expect(typeof entity.occurredOn).toBe('number');
			expect(entity.version).toEqual(envelopesAccountB[index].metadata.version);
		}

		expect(publish).toHaveBeenCalledTimes(events.length * 2);
	});

	it('should throw when trying to append an event to a stream with a version that is lower than the latest event', async () => {
		const lastEvent = events[events.length - 1];
		expect(eventStore.appendEvents(eventStreamAccountA, 3, [lastEvent])).rejects.toThrow(
			new EventStoreVersionConflictException(eventStreamAccountA, 3, 6),
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
