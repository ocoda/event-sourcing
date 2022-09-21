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
import { InMemoryEventStore } from '../../../../lib/integration/event-store';

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

describe(InMemoryEventStore, () => {
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
	});

	beforeEach(() => {
		eventStore = new InMemoryEventStore(eventMap);
		eventStore.setup();
	});

	it('should append event envelopes', () => {
		eventStore.appendEvents(eventStream, accountVersion, events);
		const entities = [...eventStore['collections'].get(eventStream.collection)];

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

	it('should retrieve events', () => {
		eventStore.appendEvents(eventStream, accountVersion, events);

		const resolvedEvents = eventStore.getEvents(eventStream);

		expect(resolvedEvents).toEqual(events);
	});

	it('should retrieve a single event', () => {
		eventStore.appendEvents(eventStream, accountVersion, events);

		const resolvedEvent = eventStore.getEvent(eventStream, envelopes[3].metadata.version);

		expect(resolvedEvent).toEqual(events[3]);
	});

	it("should throw when an event isn't found", () => {
		expect(() => eventStore.getEvent(eventStream, accountVersion)).toThrow(
			new EventNotFoundException(eventStream.streamId, accountVersion),
		);
	});

	it('should retrieve events backwards', () => {
		eventStore.appendEvents(eventStream, accountVersion, events);

		const resolvedEvents = eventStore.getEvents(eventStream, undefined, StreamReadingDirection.BACKWARD);

		expect(resolvedEvents).toEqual(events.slice().reverse());
	});

	it('should retrieve events forward from a certain version', () => {
		eventStore.appendEvents(eventStream, accountVersion, events);

		const resolvedEvents = eventStore.getEvents(eventStream, 3);

		expect(resolvedEvents).toEqual(events.slice(2));
	});

	it('should retrieve events backwards from a certain version', () => {
		eventStore.appendEvents(eventStream, accountVersion, events);

		const resolvedEvents = eventStore.getEvents(eventStream, 4, StreamReadingDirection.BACKWARD);

		expect(resolvedEvents).toEqual(events.slice(3).reverse());
	});

	it('should retrieve event-envelopes', () => {
		eventStore.appendEvents(eventStream, accountVersion, events);

		const resolvedEnvelopes = eventStore.getEnvelopes(eventStream);

		expect(resolvedEnvelopes).toHaveLength(envelopes.length);

		resolvedEnvelopes.forEach((envelope, index) => {
			expect(envelope.event).toEqual(envelopes[index].event);
			expect(envelope.payload).toEqual(envelopes[index].payload);
			expect(envelope.metadata.aggregateId).toEqual(envelopes[index].metadata.aggregateId);
			expect(envelope.metadata.occurredOn).toBeInstanceOf(Date);
			expect(envelope.metadata.version).toEqual(envelopes[index].metadata.version);
		});
	});

	it('should retrieve a single event-envelope', () => {
		eventStore.appendEvents(eventStream, accountVersion, events);

		const { event, metadata, payload } = eventStore.getEnvelope(eventStream, envelopes[3].metadata.version);

		expect(event).toEqual(envelopes[3].event);
		expect(payload).toEqual(envelopes[3].payload);
		expect(metadata.aggregateId).toEqual(envelopes[3].metadata.aggregateId);
		expect(metadata.occurredOn).toBeInstanceOf(Date);
		expect(metadata.version).toEqual(envelopes[3].metadata.version);
	});
});
