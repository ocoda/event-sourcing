import { Client } from '@elastic/elasticsearch';
import {
	Aggregate,
	EventEnvelope,
	EventMap,
	Event,
	EventNotFoundException,
	EventStream,
	Id,
	IEvent,
	StreamReadingDirection,
	AggregateRoot,
} from '../../../../lib';
import { DefaultEventSerializer } from '../../../../lib/helpers';
import { ElasticsearchEventStore } from '../../../../lib/integration/event-store';

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

describe(ElasticsearchEventStore, () => {
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

		client = new Client({ node: 'http://localhost:9200' });
		eventStore = new ElasticsearchEventStore(eventMap, client);
		await eventStore.setup();
	});

	afterEach(
		async () =>
			await client.deleteByQuery({
				index: eventStream.collection,
				body: { query: { match_all: {} } },
				refresh: true,
			}),
	);

	afterAll(async () => {
		await client.indices.delete({ index: eventStream.collection });
		await client.close();
	});

	it('should append event envelopes', async () => {
		await eventStore.appendEvents(eventStream, accountVersion, events);

		const { body } = await client.search({
			index: eventStream.collection,
			body: { query: { match_all: {} } },
		});

		expect(body.hits.hits).toHaveLength(events.length);

		body.hits.hits.forEach(({ _source }, index) => {
			expect(_source.streamId).toEqual(eventStream.streamId);
			expect(_source.event).toEqual(envelopes[index].event);
			expect(_source.payload).toEqual(envelopes[index].payload);
			expect(_source.metadata.aggregateId).toEqual(envelopes[index].metadata.aggregateId);
			expect(_source.metadata.occurredOn).toBeDefined();
			expect(_source.metadata.version).toEqual(envelopes[index].metadata.version);
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

		const resolvedEvents = await eventStore.getEvents(eventStream, undefined, StreamReadingDirection.BACKWARD);

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
