import { Aggregate } from '../aggregate';
import { EventEnvelope } from '../event-envelope';
import { EventStream } from '../event-stream';
import { Id } from '../id';
import { IEvent } from '../interfaces';
import { DefaultEventStore } from './default-event-store';

class Account extends Aggregate {}
class AccountId extends Id {}

class AccountOpenedEvent implements IEvent {}
class MoneyDepositedEvent implements IEvent {
  constructor(public readonly amount: number) {}
}
class MoneyWithdrawnEvent implements IEvent {
  constructor(public readonly amount: number) {}
}

describe(DefaultEventStore, () => {
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
      new MoneyWithdrawnEvent(15),
    ),
  ];

  it('should store and retrieve events', async () => {
    const eventStore = new DefaultEventStore();
    const eventStream = EventStream.for(Account, accountId);

    events.forEach((event) => eventStore.appendEvent(eventStream, event));

    const resolvedEvents = [];
    for await (const event of eventStore.getEvents(eventStream)) {
      resolvedEvents.push(event);
    }

    expect(resolvedEvents).toEqual(events);
  });

  it('should retrieve events from a certain version', async () => {
    const eventStore = new DefaultEventStore();
    const eventStream = EventStream.for(Account, accountId);

    events.forEach((event) => eventStore.appendEvent(eventStream, event));

    const resolvedEvents = [];
    for await (const event of eventStore.getEvents(eventStream, 3)) {
      resolvedEvents.push(event);
    }

    console.warn(resolvedEvents);

    expect(resolvedEvents).toEqual(
      events.filter(({ metadata }) => metadata.sequence >= 3),
    );
  });
});
