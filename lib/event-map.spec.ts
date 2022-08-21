import { Type } from '@nestjs/common';
import { EventName } from './decorators';
import { EventMap } from './event-map';
import {
  MissingEventMetadataException,
  UnregisteredEventException,
} from './exceptions';
import { DefaultEventSerializer } from './helpers';
import { IEvent, IEventSerializer } from './interfaces';

describe(EventMap, () => {
  const defaultSerializer = new DefaultEventSerializer();

  @EventName('account-opened')
  class AccountOpenedEvent implements IEvent {
    constructor(public readonly opened: Date) {}
  }

  @EventName('account-closed')
  class AccountClosedEvent implements IEvent {
    constructor(public readonly closed: Date) {}
  }

  it('registers and returns events', () => {
    const eventMap = new EventMap();
    eventMap.register(AccountOpenedEvent);
    eventMap.register(AccountClosedEvent);

    expect(eventMap.getEvent('account-opened')).toBe(AccountOpenedEvent);
    expect(eventMap.getEvent('account-closed')).toBe(AccountClosedEvent);
  });

  it('returns a registered custom event serializer', () => {
    const customEventSerializer: IEventSerializer<AccountOpenedEvent> = {
      serialize: ({ opened }: AccountOpenedEvent) => ({
        opened: opened.toISOString(),
      }),
      deserialize: ({ opened }: { opened: string }) =>
        new AccountOpenedEvent(new Date(opened)),
    };

    const eventMap = new EventMap();
    eventMap.register(AccountOpenedEvent, customEventSerializer);

    expect(eventMap.getSerializer('account-opened')).toBe(
      customEventSerializer,
    );
  });

  it('returns if an event-map has a certain event', () => {
    const eventMap = new EventMap();

    expect(eventMap.has('foo-created')).toBe(false);
  });

  it('throws when registering an event without an event-name', () => {
    class FooCreatedEvent implements IEvent {}

    const eventMap = new EventMap();

    expect(() => eventMap.register(FooCreatedEvent)).toThrowError(
      MissingEventMetadataException,
    );
  });

  it('throws when retrieving an unregistered event', () => {
    const eventMap = new EventMap();

    expect(() => eventMap.getEvent('foo')).toThrowError(
      UnregisteredEventException,
    );
  });
});
