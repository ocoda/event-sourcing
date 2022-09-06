import { Aggregate, EventEnvelope, EventStream, Id } from '../../models';
import { IEvent } from '../../interfaces';
import { InMemoryEventStore } from './in-memory.event-store';
import { StreamReadingDirection } from '../../constants';
import { EventNotFoundException } from '../../exceptions';

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

describe(InMemoryEventStore, () => {
	const accountId = AccountId.generate();
	const eventStream = EventStream.for(Account, accountId);

	let eventStore: InMemoryEventStore;

	const events = [
		EventEnvelope.new(accountId, 1, 'account-opened', new AccountOpenedEvent()),
		EventEnvelope.new(accountId, 2, 'account-credited', new AccountCreditedEvent(50)),
		EventEnvelope.new(accountId, 3, 'account-debited', new AccountDebitedEvent(20)),
		EventEnvelope.new(accountId, 4, 'account-credited', new AccountCreditedEvent(5)),
		EventEnvelope.new(accountId, 5, 'account-debited', new AccountDebitedEvent(35)),
		EventEnvelope.new(accountId, 6, 'account-closed', new AccountClosedEvent()),
	];

	beforeEach(() => {
		eventStore = new InMemoryEventStore();
	});

	it('should append events', async () => {
		eventStore.appendEvents(eventStream, events);

		expect(eventStore).toHaveProperty('eventCollection', new Map([[eventStream.name, events]]));
	});

	it('should retrieve a single event', async () => {
		eventStore.appendEvents(eventStream, events);

		const resolvedEvent = eventStore.getEvent(eventStream, events[3].metadata.sequence);

		expect(resolvedEvent).toEqual(events[3]);
	});

	it("should throw when an event isn't found", async () => {
		expect(() => eventStore.getEvent(eventStream, 5)).toThrow(EventNotFoundException.withVersion(eventStream.name, 5));
	});

	it('should retrieve events forward', async () => {
		eventStore.appendEvents(eventStream, events);

		const resolvedEvents = eventStore.getEvents(eventStream);

		expect(resolvedEvents).toEqual(events);
	});

	it('should retrieve events backwards', async () => {
		eventStore.appendEvents(eventStream, events);

		const resolvedEvents = eventStore.getEvents(eventStream, null, StreamReadingDirection.BACKWARD);

		expect(resolvedEvents).toEqual(events.slice().reverse());
	});

	it('should retrieve events forward from a certain version', async () => {
		eventStore.appendEvents(eventStream, events);

		const resolvedEvents = eventStore.getEvents(eventStream, 3);

		expect(resolvedEvents).toEqual(events.filter(({ metadata }) => metadata.sequence >= 3));
	});

	it('should retrieve events backwards from a certain version', async () => {
		eventStore.appendEvents(eventStream, events);

		const resolvedEvents = eventStore.getEvents(eventStream, 4, StreamReadingDirection.BACKWARD);

		expect(resolvedEvents).toEqual(events.filter(({ metadata }) => metadata.sequence >= 4).reverse());
	});
});
