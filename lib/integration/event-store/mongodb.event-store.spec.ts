import { Aggregate, EventEnvelope, EventStream, Id } from '../../models';
import { IEvent } from '../../interfaces';
import { MongoDBEventStore } from './mongodb.event-store';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { StreamReadingDirection } from '../../constants';

class Account extends Aggregate {
	constructor(private readonly id: AccountId, private readonly balance: number) {
		super();
	}
}
class AccountId extends Id {}

class AccountOpenedEvent implements IEvent {}
class AccountCreditedEvent implements IEvent {
	constructor(public readonly amount: number) {}
}
class AccountDebitedEvent implements IEvent {
	constructor(public readonly amount: number) {}
}
class AccountClosedEvent implements IEvent {}

describe(MongoDBEventStore, () => {
	let mongod: MongoMemoryServer;
	let client: MongoClient;
	let eventStore: MongoDBEventStore;

	const accountId = AccountId.generate();
	const eventStream = EventStream.for(Account, accountId);

	const events = [
		EventEnvelope.new(accountId, 1, 'account-opened', new AccountOpenedEvent()),
		EventEnvelope.new(accountId, 2, 'account-credited', new AccountCreditedEvent(50)),
		EventEnvelope.new(accountId, 3, 'account-debited', new AccountDebitedEvent(20)),
		EventEnvelope.new(accountId, 4, 'account-credited', new AccountCreditedEvent(5)),
		EventEnvelope.new(accountId, 5, 'account-debited', new AccountDebitedEvent(35)),
		EventEnvelope.new(accountId, 6, 'account-closed', new AccountClosedEvent()),
	];

	beforeAll(async () => {
		mongod = await MongoMemoryServer.create();
		client = new MongoClient(mongod.getUri());
		eventStore = new MongoDBEventStore(client.db());
	});

	afterEach(
		async () =>
			client
				.db()
				.collection(eventStream.subject)
				.deleteMany({}),
	);

	afterAll(async () => {
		await client.close();
		await mongod.stop();
	});

	it('should append events', async () => {
		await eventStore.appendEvents(eventStream, events);
		const storedEvents = await client
			.db()
			.collection(eventStream.subject)
			.find()
			.toArray();

		expect(storedEvents.map(({ _id }) => _id)).toEqual(events.map(({ eventId }) => eventId));
	});

	it('should retrieve events forward', async () => {
		await eventStore.appendEvents(eventStream, events);

		const resolvedEvents = await eventStore.getEvents(eventStream);

		expect(resolvedEvents).toEqual(events);
	});

	it('should retrieve events backwards', async () => {
		await eventStore.appendEvents(eventStream, events);

		const resolvedEvents = await eventStore.getEvents(eventStream, null, StreamReadingDirection.BACKWARD);

		expect(resolvedEvents).toEqual(events.slice().reverse());
	});

	it('should retrieve events forward from a certain version', async () => {
		await eventStore.appendEvents(eventStream, events);

		const resolvedEvents = await eventStore.getEvents(eventStream, 3);

		expect(resolvedEvents).toEqual(events.filter(({ metadata }) => metadata.sequence >= 3));
	});

	it('should retrieve events backwards from a certain version', async () => {
		await eventStore.appendEvents(eventStream, events);

		const resolvedEvents = await eventStore.getEvents(eventStream, 4, StreamReadingDirection.BACKWARD);

		expect(resolvedEvents).toEqual(events.filter(({ metadata }) => metadata.sequence >= 4).reverse());
	});
});
