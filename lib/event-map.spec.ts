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

  class UnregisteredEvent implements IEvent {}

  it('throws when registering an event without an event-name', () => {
    class FooCreatedEvent implements IEvent {}

    const eventMap = new EventMap();

    expect(() => eventMap.register(FooCreatedEvent)).toThrowError(
      MissingEventMetadataException,
    );
  });

  it('returns if an event-map has a certain event', () => {
    const eventMap = new EventMap();
    eventMap.register(AccountOpenedEvent);

    expect(eventMap.has('account-opened')).toBe(true);
    expect(eventMap.has(AccountOpenedEvent)).toBe(true);
    expect(eventMap.has('unregistered-event')).toBe(false);
    expect(eventMap.has(UnregisteredEvent)).toBe(false);
  });

  it('returns the constructor of a registered event by its name', () => {
    const eventMap = new EventMap();
    eventMap.register(AccountOpenedEvent);
    eventMap.register(AccountClosedEvent);

    expect(eventMap.getConstructor('account-opened')).toBe(AccountOpenedEvent);
    expect(eventMap.getConstructor('account-closed')).toBe(AccountClosedEvent);
  });

  it('throws when trying to get the constructor of an unregistered event by its name', () => {
    const eventMap = new EventMap();

    expect(() => eventMap.getConstructor('unregistered-event')).toThrowError(
      new UnregisteredEventException('unregistered-event'),
    );
  });

  it('returns the name of a registered event by its constructor', () => {
    const eventMap = new EventMap();
    eventMap.register(AccountOpenedEvent);
    eventMap.register(AccountClosedEvent);

    expect(eventMap.getName(AccountOpenedEvent)).toBe('account-opened');
    expect(eventMap.getName(AccountClosedEvent)).toBe('account-closed');
  });

  it('throws when trying to get the name of an unregistered event by its constructor', () => {
    const eventMap = new EventMap();

    expect(() => eventMap.getName(UnregisteredEvent)).toThrowError(
      new UnregisteredEventException('UnregisteredEvent'),
    );
  });

  it('returns the serializer of a registered event by its name', () => {
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

  it('returns the serializer of a registered event by its constructor', () => {
    const customEventSerializer: IEventSerializer<AccountOpenedEvent> = {
      serialize: ({ opened }: AccountOpenedEvent) => ({
        opened: opened.toISOString(),
      }),
      deserialize: ({ opened }: { opened: string }) =>
        new AccountOpenedEvent(new Date(opened)),
    };

    const eventMap = new EventMap();
    eventMap.register(AccountOpenedEvent, customEventSerializer);

    expect(eventMap.getSerializer(AccountOpenedEvent)).toBe(
      customEventSerializer,
    );
  });
});
