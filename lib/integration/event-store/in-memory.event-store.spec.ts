import { Aggregate, EventEnvelope, EventStream, Id } from '../../models';
import { IEvent } from '../../interfaces';
import { InMemoryEventStore } from './in-memory.event-store';
import { StreamReadingDirection } from '../../constants';
import { EventNotFoundException } from '../../exceptions';
import { EventName } from '../../decorators';
import { DefaultEventSerializer } from '../../helpers';
import { EventMap } from '../../event-map';

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

describe(InMemoryEventStore, () => {
	const now = Date.now();
	let eventStore: InMemoryEventStore;
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
			EventEnvelope.new(accountId, 1, 'account-opened', eventMap.serializeEvent(events[0])),
			EventEnvelope.new(accountId, 2, 'account-credited', eventMap.serializeEvent(events[1])),
			EventEnvelope.new(accountId, 3, 'account-debited', eventMap.serializeEvent(events[2])),
			EventEnvelope.new(accountId, 4, 'account-credited', eventMap.serializeEvent(events[3])),
			EventEnvelope.new(accountId, 5, 'account-debited', eventMap.serializeEvent(events[4])),
			EventEnvelope.new(accountId, 6, 'account-closed', eventMap.serializeEvent(events[5])),
		];
	});

	beforeEach(() => {
		eventStore = new InMemoryEventStore(eventMap);
	});

	afterAll(() => jest.clearAllMocks());

	it('should append event envelopes', async () => {
		eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		expect(
			eventStore['eventCollection'].get(eventStream.name).map(({ eventName, payload }) => ({ eventName, payload })),
		).toEqual(envelopes.map(({ eventName, payload }) => ({ eventName, payload })));
	});

	it('should retrieve events', async () => {
		eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		const resolvedEvents = eventStore.getEvents(eventStream);

		expect(resolvedEvents).toEqual(events);
	});

	it('should retrieve a single event', async () => {
		eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		const resolvedEvent = eventStore.getEvent(eventStream, envelopes[3].metadata.sequence);

		expect(resolvedEvent).toEqual(events[3]);
	});

	it("should throw when an event isn't found", async () => {
		expect(() => eventStore.getEvent(eventStream, accountVersion)).toThrow(
			EventNotFoundException.withVersion(eventStream.name, accountVersion),
		);
	});

	it('should retrieve events backwards', async () => {
		eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		const resolvedEvents = eventStore.getEvents(eventStream, null, StreamReadingDirection.BACKWARD);

		expect(resolvedEvents).toEqual(events.slice().reverse());
	});

	it('should retrieve events forward from a certain version', async () => {
		eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		const resolvedEvents = eventStore.getEvents(eventStream, 3);

		expect(resolvedEvents).toEqual(events.slice(2));
	});

	it('should retrieve events backwards from a certain version', async () => {
		eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		const resolvedEvents = eventStore.getEvents(eventStream, 4, StreamReadingDirection.BACKWARD);

		expect(resolvedEvents).toEqual(events.slice(3).reverse());
	});

	it('should retrieve event-envelopes', async () => {
		eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		const resolvedEvents = eventStore.getEnvelopes(eventStream);

		expect(resolvedEvents.map(({ constructor, eventId, ...rest }) => ({ constructor, ...rest }))).toEqual(
			envelopes.map(({ constructor, eventId, ...rest }) => ({ constructor, ...rest })),
		);
	});

	it('should retrieve a single event-envelope', async () => {
		eventStore.appendEvents(accountId, accountVersion, eventStream, events);

		const { constructor, eventId, ...rest } = eventStore.getEnvelope(eventStream, envelopes[3].metadata.sequence);

		expect(constructor).toEqual(envelopes[3].constructor);
		expect(rest.eventName).toEqual(envelopes[3].eventName);
		expect(rest.metadata).toEqual(envelopes[3].metadata);
		expect(rest.payload).toEqual(envelopes[3].payload);
	});
});
