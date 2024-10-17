import {
	Aggregate,
	AggregateRoot,
	DefaultEventSerializer,
	Event,
	EventEnvelope,
	EventId,
	EventMap,
	EventStream,
	type IEvent,
	type ISnapshot,
	SnapshotEnvelope,
	SnapshotStream,
	UUID,
} from '@ocoda/event-sourcing';

// #region *Account*
export class AccountId extends UUID {}

@Aggregate({ streamName: 'account' })
export class Account extends AggregateRoot {
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

export const EventClasses = [AccountOpenedEvent, AccountCreditedEvent, AccountDebitedEvent, AccountClosedEvent];

export const idAccountA = AccountId.generate();
export const eventStreamAccountA = EventStream.for(Account, idAccountA);
export const getAccountAEventEnvelopes = (eventMap: EventMap, events: IEvent[]): EventEnvelope[] => [
	EventEnvelope.create('account-opened', eventMap.serializeEvent(events[0]), {
		aggregateId: idAccountA.value,
		version: 1,
		eventId: EventId.generate(new Date('2021-01-01T00:00:00Z')),
	}),
	EventEnvelope.create('account-credited', eventMap.serializeEvent(events[1]), {
		aggregateId: idAccountA.value,
		version: 2,
		eventId: EventId.generate(new Date('2021-02-01T00:00:20Z')),
	}),
	EventEnvelope.create('account-debited', eventMap.serializeEvent(events[2]), {
		aggregateId: idAccountA.value,
		version: 3,
		eventId: EventId.generate(new Date('2021-02-01T00:00:40Z')),
	}),
	EventEnvelope.create('account-credited', eventMap.serializeEvent(events[3]), {
		aggregateId: idAccountA.value,
		version: 4,
		eventId: EventId.generate(new Date('2021-03-01T00:01:00Z')),
	}),
	EventEnvelope.create('account-debited', eventMap.serializeEvent(events[4]), {
		aggregateId: idAccountA.value,
		version: 5,
		eventId: EventId.generate(new Date('2021-03-01T00:01:20Z')),
	}),
	EventEnvelope.create('account-closed', eventMap.serializeEvent(events[5]), {
		aggregateId: idAccountA.value,
		version: 6,
		eventId: EventId.generate(new Date('2021-05-01T00:01:40Z')),
	}),
];
export const snapshotStreamAccountA = SnapshotStream.for(Account, idAccountA);
export const snapshotsAccountA: ISnapshot<Account>[] = [
	{ balance: 0 },
	{ balance: 50 },
	{ balance: 20 },
	{ balance: 60 },
	{ balance: 50 },
];
export const snapshotEnvelopesAccountA = [
	SnapshotEnvelope.create<Account>(snapshotsAccountA[0], {
		aggregateId: idAccountA.value,
		version: 1,
	}),
	SnapshotEnvelope.create<Account>(snapshotsAccountA[1], {
		aggregateId: idAccountA.value,
		version: 10,
	}),
	SnapshotEnvelope.create<Account>(snapshotsAccountA[2], {
		aggregateId: idAccountA.value,
		version: 20,
	}),
	SnapshotEnvelope.create<Account>(snapshotsAccountA[3], {
		aggregateId: idAccountA.value,
		version: 30,
	}),
	SnapshotEnvelope.create<Account>(snapshotsAccountA[4], {
		aggregateId: idAccountA.value,
		version: 40,
	}),
];

export const idAccountB = AccountId.generate();
export const eventStreamAccountB = EventStream.for(Account, idAccountB);
export const getAccountBEventEnvelopes = (eventMap: EventMap, events: IEvent[]): EventEnvelope[] => [
	EventEnvelope.create('account-opened', eventMap.serializeEvent(events[0]), {
		aggregateId: idAccountB.value,
		version: 1,
		eventId: EventId.generate(new Date('2021-01-01T00:00:10Z')),
	}),
	EventEnvelope.create('account-credited', eventMap.serializeEvent(events[1]), {
		aggregateId: idAccountB.value,
		version: 2,
		eventId: EventId.generate(new Date('2021-02-01T00:00:30Z')),
	}),
	EventEnvelope.create('account-debited', eventMap.serializeEvent(events[2]), {
		aggregateId: idAccountB.value,
		version: 3,
		eventId: EventId.generate(new Date('2021-02-01T00:00:50Z')),
	}),
	EventEnvelope.create('account-credited', eventMap.serializeEvent(events[3]), {
		aggregateId: idAccountB.value,
		version: 4,
		eventId: EventId.generate(new Date('2021-03-01T00:01:10Z')),
	}),
	EventEnvelope.create('account-debited', eventMap.serializeEvent(events[4]), {
		aggregateId: idAccountB.value,
		version: 5,
		eventId: EventId.generate(new Date('2021-03-01T00:01:30Z')),
	}),
	EventEnvelope.create('account-closed', eventMap.serializeEvent(events[5]), {
		aggregateId: idAccountB.value,
		version: 6,
		eventId: EventId.generate(new Date('2021-05-01T00:01:50Z')),
	}),
];
export const snapshotStreamAccountB = SnapshotStream.for(Account, idAccountB);
export const snapshotsAccountB: ISnapshot<Account>[] = [
	{ balance: 0 },
	{ balance: 10 },
	{ balance: 20 },
	{ balance: 30 },
];
export const snapshotEnvelopesAccountB = [
	SnapshotEnvelope.create<Account>(snapshotsAccountB[0], {
		aggregateId: idAccountB.value,
		version: 1,
	}),
	SnapshotEnvelope.create<Account>(snapshotsAccountB[1], {
		aggregateId: idAccountB.value,
		version: 10,
	}),
	SnapshotEnvelope.create<Account>(snapshotsAccountB[2], {
		aggregateId: idAccountB.value,
		version: 20,
	}),
	SnapshotEnvelope.create<Account>(snapshotsAccountB[3], {
		aggregateId: idAccountB.value,
		version: 30,
	}),
];

export const getAccountEventEnvelopes = (
	accountId: AccountId,
	eventMap: EventMap,
	events: IEvent[],
): EventEnvelope[] => [
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
// #endregion

// #region *Customer*
export class CustomerId extends UUID {}

@Aggregate({ streamName: 'customer' })
export class Customer extends AggregateRoot {
	constructor(
		private readonly id: CustomerId,
		private readonly name: string,
	) {
		super();
	}
}

export const customerId = CustomerId.generate();
export const snapshotStreamCustomer = SnapshotStream.for(Customer, customerId);
export const customerSnapshot: ISnapshot<Customer> = { name: 'Hubert Farnsworth' };
// #endregion

export const getEventMap = (): EventMap => {
	const eventMap = new EventMap();
	eventMap.register(AccountOpenedEvent, DefaultEventSerializer.for(AccountOpenedEvent));
	eventMap.register(AccountCreditedEvent, DefaultEventSerializer.for(AccountCreditedEvent));
	eventMap.register(AccountDebitedEvent, DefaultEventSerializer.for(AccountDebitedEvent));
	eventMap.register(AccountClosedEvent, DefaultEventSerializer.for(AccountClosedEvent));

	return eventMap;
};

export const getEvents = (): IEvent[] => [
	new AccountOpenedEvent(),
	new AccountCreditedEvent(50),
	new AccountDebitedEvent(20),
	new AccountCreditedEvent(5),
	new AccountDebitedEvent(35),
	new AccountClosedEvent(),
];
