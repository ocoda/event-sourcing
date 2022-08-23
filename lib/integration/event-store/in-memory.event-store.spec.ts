import { EventStream } from '../../models/event-stream';
import { IEvent } from '../../interfaces';
import { SnapshotEnvelope } from '../../models/snapshot-envelope';
import { EventEnvelope } from '../../models/event-envelope';
import { InMemoryEventStore } from './in-memory.event-store';
import { StreamReadingDirection } from '../../event-store';
import { Aggregate, Id } from '../../models';

class Account extends Aggregate {}
class AccountId extends Id {}

class AccountOpenedEvent implements IEvent {}
class MoneyDepositedEvent implements IEvent {
  constructor(public readonly amount: number) {}
}
class MoneyWithdrawnEvent implements IEvent {
  constructor(public readonly amount: number) {}
}
class AccountClosedEvent implements IEvent {}

describe(InMemoryEventStore, () => {
  const accountId = AccountId.generate();

  const events = [
    EventEnvelope.new(accountId, 1, 'account-opened', new AccountOpenedEvent()),
    EventEnvelope.new(
      accountId,
      2,
      'money-deposited',
      new MoneyDepositedEvent(50),
    ),
    EventEnvelope.new(
      accountId,
      3,
      'money-withdrawn',
      new MoneyWithdrawnEvent(20),
    ),
    EventEnvelope.new(
      accountId,
      4,
      'money-deposited',
      new MoneyDepositedEvent(5),
    ),
    EventEnvelope.new(
      accountId,
      5,
      'money-withdrawn',
      new MoneyWithdrawnEvent(35),
    ),
    EventEnvelope.new(accountId, 6, 'account-closed', new AccountClosedEvent()),
  ];

  it('should retrieve events forward', async () => {
    const eventStore = new InMemoryEventStore();
    const eventStream = EventStream.for(Account, accountId);

    events.forEach((event) => eventStore.appendEvents(eventStream, event));

    const resolvedEvents = [];
    for await (const event of eventStore.getEvents(eventStream)) {
      resolvedEvents.push(event);
    }

    expect(resolvedEvents).toEqual(events);
  });

  it('should retrieve events backward', async () => {
    const eventStore = new InMemoryEventStore();
    const eventStream = EventStream.for(Account, accountId);

    events.forEach((event) => eventStore.appendEvents(eventStream, event));

    const resolvedEvents = [];
    for await (const event of eventStore.getEvents(
      eventStream,
      null,
      StreamReadingDirection.BACKWARD,
    )) {
      resolvedEvents.push(event);
    }

    expect(resolvedEvents).toEqual(events.slice().reverse());
  });

  it('should retrieve events forward from a certain version', async () => {
    const eventStore = new InMemoryEventStore();
    const eventStream = EventStream.for(Account, accountId);

    events.forEach((event) => eventStore.appendEvents(eventStream, event));

    const resolvedEvents = [];
    for await (const event of eventStore.getEvents(eventStream, 3)) {
      resolvedEvents.push(event);
    }

    expect(resolvedEvents).toEqual(
      events.filter(({ metadata }) => metadata.sequence >= 3),
    );
  });

  it('should retrieve events backwards from a certain version', async () => {
    const eventStore = new InMemoryEventStore();
    const eventStream = EventStream.for(Account, accountId);

    events.forEach((event) => eventStore.appendEvents(eventStream, event));

    const resolvedEvents = [];
    for await (const event of eventStore.getEvents(
      eventStream,
      4,
      StreamReadingDirection.BACKWARD,
    )) {
      resolvedEvents.push(event);
    }

    expect(resolvedEvents).toEqual(
      events.filter(({ metadata }) => metadata.sequence >= 4).reverse(),
    );
  });

  it('should retrieve snapshots', async () => {
    const eventStore = new InMemoryEventStore();
    const eventStream = EventStream.for(Account, accountId);

    const snapshot = SnapshotEnvelope.new(accountId, 5, { balance: 45 });
    eventStore.appendSnapshot(eventStream, snapshot);

    const resolvedSnapshot = eventStore.getSnapshot(eventStream, 5);

    expect(resolvedSnapshot.payload).toEqual({ balance: 45 });
  });
});
