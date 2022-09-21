import { MongoClient } from 'mongodb';
import {
	Aggregate,
	AggregateRoot,
	Event,
	EventEnvelope,
	EventMap,
	EventNotFoundException,
	EventStream,
	Id,
	IEvent,
	StreamReadingDirection,
} from '../../../../lib';
import { DefaultEventSerializer } from '../../../../lib/helpers';
import { MongoDBEventStore, MongoEventEntity } from '../../../../lib/integration/event-store';

class AccountId extends Id {}

@Aggregate({ streamName: 'account' })
class Account extends AggregateRoot {
	constructor(private readonly id: AccountId, private readonly balance: number) {
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

describe(MongoDBEventStore, () => {
	let client: MongoClient;
	let eventStore: MongoDBEventStore;
	let envelopes: EventEnvelope[];

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

	const accountId = AccountId.generate();
	const accountVersion = events.length;
	const eventStream = EventStream.for(Account, accountId);

	beforeAll(async () => {
		envelopes = [
			EventEnvelope.create('account-opened', eventMap.serializeEvent(events[0]), {
				aggregateId: accountId.value,
				version: 1,
			}),
			EventEnvelope.create('account-credited', eventMap.serializeEvent(events[1]), {
				aggregateId: accountId.value,
				version: 2,
			}),
			EventEnvelope.create('account-debited', eventMap.serializeEvent(events[2]), {
				aggregateId: accountId.value,
				version: 3,
			}),
			EventEnvelope.create('account-credited', eventMap.serializeEvent(events[3]), {
				aggregateId: accountId.value,
				version: 4,
			}),
			EventEnvelope.create('account-debited', eventMap.serializeEvent(events[4]), {
				aggregateId: accountId.value,
				version: 5,
			}),
			EventEnvelope.create('account-closed', eventMap.serializeEvent(events[5]), {
				aggregateId: accountId.value,
				version: 6,
			}),
		];

		client = new MongoClient('mongodb://localhost:27017');
		eventStore = new MongoDBEventStore(eventMap, client.db());
		await eventStore.setup();
	});

	afterEach(
		async () =>
			await client
				.db()
				.collection(eventStream.collection)
				.deleteMany({}),
	);

	afterAll(async () => {
		await client.db().dropCollection(eventStream.collection);
		await client.close();
	});

	it('should append event envelopes', async () => {
		await eventStore.appendEvents(eventStream, accountVersion, events);
		const entities = await client
			.db()
			.collection<MongoEventEntity>(eventStream.collection)
			.find()
			.toArray();

		expect(entities).toHaveLength(events.length);

		entities.forEach((entity, index) => {
			expect(entity.streamId).toEqual(eventStream.streamId);
			expect(entity.event).toEqual(envelopes[index].event);
			expect(entity.payload).toEqual(envelopes[index].payload);
			expect(entity.metadata.aggregateId).toEqual(envelopes[index].metadata.aggregateId);
			expect(entity.metadata.occurredOn).toBeInstanceOf(Date);
			expect(entity.metadata.version).toEqual(envelopes[index].metadata.version);
		});
	});

	it('should retrieve events', async () => {
		await eventStore.appendEvents(eventStream, accountVersion, events);

		const resolvedEvents = await eventStore.getEvents(eventStream);

		expect(resolvedEvents).toEqual(events);
	});

	it('should retrieve a single event', async () => {
		await eventStore.appendEvents(eventStream, accountVersion, events);

		const resolvedEvent = await eventStore.getEvent(eventStream, envelopes[3].metadata.version);

		expect(resolvedEvent).toEqual(events[3]);
	});

	it("should throw when an event isn't found", async () => {
		await expect(eventStore.getEvent(eventStream, accountVersion)).rejects.toThrow(
			new EventNotFoundException(eventStream.streamId, accountVersion),
		);
	});

	it('should retrieve events backwards', async () => {
		await eventStore.appendEvents(eventStream, accountVersion, events);

		const resolvedEvents = await eventStore.getEvents(eventStream, null, StreamReadingDirection.BACKWARD);

		expect(resolvedEvents).toEqual(events.slice().reverse());
	});

	it('should retrieve events forward from a certain version', async () => {
		await eventStore.appendEvents(eventStream, accountVersion, events);

		const resolvedEvents = await eventStore.getEvents(eventStream, 3);

		expect(resolvedEvents).toEqual(events.slice(2));
	});

	it('should retrieve events backwards from a certain version', async () => {
		await eventStore.appendEvents(eventStream, accountVersion, events);

		const resolvedEvents = await eventStore.getEvents(eventStream, 4, StreamReadingDirection.BACKWARD);

		expect(resolvedEvents).toEqual(events.slice(3).reverse());
	});

	it('should retrieve event-envelopes', async () => {
		await eventStore.appendEvents(eventStream, accountVersion, events);

		const resolvedEnvelopes = await eventStore.getEnvelopes(eventStream);

		expect(resolvedEnvelopes).toHaveLength(envelopes.length);

		resolvedEnvelopes.forEach((envelope, index) => {
			expect(envelope.event).toEqual(envelopes[index].event);
			expect(envelope.payload).toEqual(envelopes[index].payload);
			expect(envelope.metadata.aggregateId).toEqual(envelopes[index].metadata.aggregateId);
			expect(envelope.metadata.occurredOn).toBeInstanceOf(Date);
			expect(envelope.metadata.version).toEqual(envelopes[index].metadata.version);
		});
	});

	it('should retrieve a single event-envelope', async () => {
		await eventStore.appendEvents(eventStream, accountVersion, events);

		const { event, metadata, payload } = await eventStore.getEnvelope(eventStream, envelopes[3].metadata.version);

		expect(event).toEqual(envelopes[3].event);
		expect(payload).toEqual(envelopes[3].payload);
		expect(metadata.aggregateId).toEqual(envelopes[3].metadata.aggregateId);
		expect(metadata.occurredOn).toBeInstanceOf(Date);
		expect(metadata.version).toEqual(envelopes[3].metadata.version);
	});
});
