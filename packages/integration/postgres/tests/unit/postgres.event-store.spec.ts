import { NestApplication, NestFactory } from '@nestjs/core';
import {
	Aggregate,
	AggregateRoot,
	DefaultEventSerializer,
	Event,
	EventCollection,
	EventEnvelope,
	EventMap,
	EventNotFoundException,
	EventSourcingModule,
	EventStore,
	EventStream,
	IEvent,
	StreamReadingDirection,
	UUID,
} from '@ocoda/event-sourcing';
import { PostgresEventEntity, PostgresEventStore, PostgresEventStoreConfig } from '@ocoda/event-sourcing-postgres';
import { InMemorySnapshotStore } from '@ocoda/event-sourcing/integration/snapshot-store';
import { PoolClient } from 'pg';

class AccountId extends UUID {}

@Aggregate({ streamName: 'account' })
class Account extends AggregateRoot {
	constructor(
		private readonly id: AccountId,
		private readonly balance: number,
	) {
		super();
	}
}

@Event('account-opened')
class AccountOpenedEvent implements IEvent {}

@Event('account-credited')
class AccountCreditedEvent implements IEvent {
	constructor(public readonly amount: number) {}
}

@Event('account-debited')
class AccountDebitedEvent implements IEvent {
	constructor(public readonly amount: number) {}
}

@Event('account-closed')
class AccountClosedEvent implements IEvent {}

describe(PostgresEventStore, () => {
	let app: NestApplication;
	let eventStore: PostgresEventStore;

	let client: PoolClient;
	const publish = jest.fn(async () => Promise.resolve());

	const eventMap = new EventMap();
	eventMap.register(AccountOpenedEvent, DefaultEventSerializer.for(AccountOpenedEvent));
	eventMap.register(AccountCreditedEvent, DefaultEventSerializer.for(AccountCreditedEvent));
	eventMap.register(AccountDebitedEvent, DefaultEventSerializer.for(AccountDebitedEvent));
	eventMap.register(AccountClosedEvent, DefaultEventSerializer.for(AccountClosedEvent));

	const events = [
		new AccountOpenedEvent(),
		new AccountCreditedEvent(50),
		new AccountDebitedEvent(20),
		new AccountCreditedEvent(5),
		new AccountDebitedEvent(35),
		new AccountClosedEvent(),
	];

	const idAccountA = AccountId.generate();
	const eventStreamAccountA = EventStream.for(Account, idAccountA);

	const idAccountB = AccountId.generate();
	const eventStreamAccountB = EventStream.for(Account, idAccountB);

	const envelopesAccountA = [
		EventEnvelope.create('account-opened', eventMap.serializeEvent(events[0]), {
			aggregateId: idAccountA.value,
			version: 1,
		}),
		EventEnvelope.create('account-credited', eventMap.serializeEvent(events[1]), {
			aggregateId: idAccountA.value,
			version: 2,
		}),
		EventEnvelope.create('account-debited', eventMap.serializeEvent(events[2]), {
			aggregateId: idAccountA.value,
			version: 3,
		}),
		EventEnvelope.create('account-credited', eventMap.serializeEvent(events[3]), {
			aggregateId: idAccountA.value,
			version: 4,
		}),
		EventEnvelope.create('account-debited', eventMap.serializeEvent(events[4]), {
			aggregateId: idAccountA.value,
			version: 5,
		}),
		EventEnvelope.create('account-closed', eventMap.serializeEvent(events[5]), {
			aggregateId: idAccountA.value,
			version: 6,
		}),
	];
	const envelopesAccountB = [
		EventEnvelope.create('account-opened', eventMap.serializeEvent(events[0]), {
			aggregateId: idAccountB.value,
			version: 1,
		}),
		EventEnvelope.create('account-credited', eventMap.serializeEvent(events[1]), {
			aggregateId: idAccountB.value,
			version: 2,
		}),
		EventEnvelope.create('account-debited', eventMap.serializeEvent(events[2]), {
			aggregateId: idAccountB.value,
			version: 3,
		}),
		EventEnvelope.create('account-credited', eventMap.serializeEvent(events[3]), {
			aggregateId: idAccountB.value,
			version: 4,
		}),
		EventEnvelope.create('account-debited', eventMap.serializeEvent(events[4]), {
			aggregateId: idAccountB.value,
			version: 5,
		}),
		EventEnvelope.create('account-closed', eventMap.serializeEvent(events[5]), {
			aggregateId: idAccountB.value,
			version: 6,
		}),
	];

	beforeAll(async () => {
		app = await NestFactory.create(
			EventSourcingModule.forRootAsync<PostgresEventStoreConfig>({
				useFactory: () => ({
					events: [AccountOpenedEvent, AccountCreditedEvent, AccountDebitedEvent, AccountClosedEvent],
					eventStore: {
						driver: PostgresEventStore,
						host: '127.0.0.1',
						port: 5432,
						user: 'postgres',
						password: 'postgres',
						database: 'postgres',
					},
					snapshotStore: {
						driver: InMemorySnapshotStore,
					},
				}),
			}),
		);
		await app.init();

		eventStore = app.get<PostgresEventStore>(EventStore);
		eventStore.publish = publish;

		// biome-ignore lint/complexity/useLiteralKeys: Needed to check the internal workings of the event store
		client = eventStore['client'];
	});

	afterAll(async () => {
		await client.query(`DROP TABLE IF EXISTS "${EventCollection.get()}"`);
		await app.close();
	});

	it('should append event envelopes', async () => {
		await Promise.all([
			eventStore.appendEvents(eventStreamAccountA, 3, events.slice(0, 3)),
			eventStore.appendEvents(eventStreamAccountB, 3, events.slice(0, 3)),
			eventStore.appendEvents(eventStreamAccountA, 6, events.slice(3)),
			eventStore.appendEvents(eventStreamAccountB, 6, events.slice(3)),
		]);

		const { rows: entities } = await client.query<PostgresEventEntity>(`
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
			expect(entity.occurred_on).toBeInstanceOf(Date);
			expect(entity.version).toEqual(envelopesAccountA[index].metadata.version);
		}

		for (const [index, entity] of entitiesAccountB.entries()) {
			expect(entity.stream_id).toEqual(eventStreamAccountB.streamId);
			expect(entity.event).toEqual(envelopesAccountB[index].event);
			expect(entity.payload).toEqual(envelopesAccountB[index].payload);
			expect(entity.aggregate_id).toEqual(envelopesAccountB[index].metadata.aggregateId);
			expect(entity.occurred_on).toBeInstanceOf(Date);
			expect(entity.version).toEqual(envelopesAccountB[index].metadata.version);
		}

		expect(publish).toHaveBeenCalledTimes(events.length * 2);
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
