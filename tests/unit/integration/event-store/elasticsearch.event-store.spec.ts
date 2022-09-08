import { Client } from '@elastic/elasticsearch';
import {
	Aggregate,
	EventEnvelope,
	EventMap,
	EventName,
	EventNotFoundException,
	EventStream,
	Id,
	IEvent,
	StreamReadingDirection,
} from '../../../../lib';
import { DefaultEventSerializer } from '../../../../lib/helpers';
import { ElasticsearchEventEnvelopeEntity, ElasticsearchEventStore } from '../../../../lib/integration/event-store';

class Account extends Aggregate {
	constructor(private readonly id: AccountId, private readonly balance: number) {
		super();
	}
}
class AccountId extends Id {}

@EventName('account-opened')
class AccountOpenedEvent implements IEvent {}

@EventName('account-credited')
class AccountCreditedEvent implements IEvent {
	constructor(public readonly amount: number) {}
}

@EventName('account-debited')
class AccountDebitedEvent implements IEvent {
	constructor(public readonly amount: number) {}
}

@EventName('account-closed')
class AccountClosedEvent implements IEvent {}

describe(ElasticsearchEventStore, () => {
	const now = Date.now();
	let client: Client;
	let eventStore: ElasticsearchEventStore;
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

	beforeAll(() => {
		jest.spyOn(global.Date, 'now').mockImplementation(() => now);

		envelopes = [
			EventEnvelope.create(accountId, 1, 'account-opened', eventMap.serializeEvent(events[0])),
			EventEnvelope.create(accountId, 2, 'account-credited', eventMap.serializeEvent(events[1])),
			EventEnvelope.create(accountId, 3, 'account-debited', eventMap.serializeEvent(events[2])),
			EventEnvelope.create(accountId, 4, 'account-credited', eventMap.serializeEvent(events[3])),
			EventEnvelope.create(accountId, 5, 'account-debited', eventMap.serializeEvent(events[4])),
			EventEnvelope.create(accountId, 6, 'account-closed', eventMap.serializeEvent(events[5])),
		];

		client = new Client({ node: 'http://localhost:9200' });
		eventStore = new ElasticsearchEventStore(eventMap, client);
	});

	afterEach(
		async () =>
			await client.deleteByQuery({
				index: eventStream.subject,
				body: { query: { match_all: {} } },
				refresh: true,
			}),
	);

	afterAll(async () => {
		jest.clearAllMocks();
		await client.close();
	});

	it('should append event envelopes', async () => {
		await eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		const { body } = await client.search({
			index: eventStream.subject,
			body: { query: { match_all: {} } },
		});

		expect((body.hits.hits as ElasticsearchEventEnvelopeEntity[]).map(({ _source }) => _source)).toEqual(
			envelopes.map(({ eventId, ...rest }) => ({ stream: eventStream.name, ...rest })),
		);
	});

	it('should retrieve events', async () => {
		await eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		const resolvedEvents = await eventStore.getEvents(eventStream);

		expect(resolvedEvents).toEqual(events);
	});

	it('should retrieve a single event', async () => {
		await eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		const resolvedEvent = await eventStore.getEvent(eventStream, envelopes[3].metadata.sequence);

		expect(resolvedEvent).toEqual(events[3]);
	});

	it("should throw when an event isn't found", async () => {
		await expect(eventStore.getEvent(eventStream, accountVersion)).rejects.toThrow(
			EventNotFoundException.withVersion(eventStream.name, accountVersion),
		);
	});

	it('should retrieve events backwards', async () => {
		await eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		const resolvedEvents = await eventStore.getEvents(eventStream, undefined, StreamReadingDirection.BACKWARD);

		expect(resolvedEvents).toEqual(events.slice().reverse());
	});

	it('should retrieve events forward from a certain version', async () => {
		await eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		const resolvedEvents = await eventStore.getEvents(eventStream, 3);

		expect(resolvedEvents).toEqual(events.slice(2));
	});

	it('should retrieve events backwards from a certain version', async () => {
		await eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		const resolvedEvents = await eventStore.getEvents(eventStream, 4, StreamReadingDirection.BACKWARD);

		expect(resolvedEvents).toEqual(events.slice(3).reverse());
	});

	it('should retrieve event-envelopes', async () => {
		await eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		const resolvedEvents = await eventStore.getEnvelopes(eventStream);

		expect(resolvedEvents.map(({ eventName, payload, metadata }) => ({ eventName, payload, metadata }))).toEqual(
			envelopes.map(({ eventName, payload, metadata }) => ({ eventName, payload, metadata })),
		);
	});

	it('should retrieve a single event-envelope', async () => {
		await eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		const { eventId, ...rest } = await eventStore.getEnvelope(eventStream, envelopes[3].metadata.sequence);

		expect(rest.eventName).toEqual(envelopes[3].eventName);
		expect(rest.metadata).toEqual(envelopes[3].metadata);
		expect(rest.payload).toEqual(envelopes[3].payload);
	});
});
