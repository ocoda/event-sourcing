import { EventName } from './decorators';
import { EventMap } from './event-map';
import { MissingEventMetadataException, UnregisteredEventException } from './exceptions';
import { DefaultEventSerializer } from './helpers';
import { IEvent, IEventSerializer } from './interfaces';
import { Id } from './models';

describe(EventMap, () => {
	@EventName('account-opened')
	class AccountOpenedEvent implements IEvent {
		constructor(public readonly opened: Date) {}
	}

	@EventName('account-credited')
	class AccountCreditedEvent implements IEvent {
		constructor(public readonly amount: number) {}
	}

	@EventName('account-debited')
	class AccountDebitedEvent implements IEvent {
		constructor(public readonly amount: number) {}
	}

	@EventName('account-closed')
	class AccountClosedEvent implements IEvent {
		constructor(public readonly closed: Date) {}
	}

	class UnregisteredEvent implements IEvent {}

	it('throws when registering an event without an event-name', () => {
		class FooCreatedEvent implements IEvent {}

		const eventMap = new EventMap();

		expect(() => eventMap.register(FooCreatedEvent)).toThrowError(MissingEventMetadataException);
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

		expect(() => eventMap.getName(UnregisteredEvent)).toThrowError(new UnregisteredEventException('UnregisteredEvent'));
	});

	it('returns the serializer of a registered event by its name', () => {
		const customEventSerializer: IEventSerializer<AccountOpenedEvent> = {
			serialize: ({ opened }: AccountOpenedEvent) => ({
				opened: opened.toISOString(),
			}),
			deserialize: ({ opened }: { opened: string }) => new AccountOpenedEvent(new Date(opened)),
		};

		const eventMap = new EventMap();
		eventMap.register(AccountOpenedEvent, customEventSerializer);

		expect(eventMap.getSerializer('account-opened')).toBe(customEventSerializer);
	});

	it('returns the serializer of a registered event by its constructor', () => {
		const customEventSerializer: IEventSerializer<AccountOpenedEvent> = {
			serialize: ({ opened }: AccountOpenedEvent) => ({
				opened: opened.toISOString(),
			}),
			deserialize: ({ opened }: { opened: string }) => new AccountOpenedEvent(new Date(opened)),
		};

		const eventMap = new EventMap();
		eventMap.register(AccountOpenedEvent, customEventSerializer);

		expect(eventMap.getSerializer(AccountOpenedEvent)).toBe(customEventSerializer);
	});

	it('creates event-envelopes', () => {
		class AccountId extends Id {}

		const eventMap = new EventMap();
		eventMap.register(AccountOpenedEvent, DefaultEventSerializer.for(AccountOpenedEvent));
		eventMap.register(AccountCreditedEvent, DefaultEventSerializer.for(AccountCreditedEvent));
		eventMap.register(AccountDebitedEvent, DefaultEventSerializer.for(AccountDebitedEvent));
		eventMap.register(AccountClosedEvent, DefaultEventSerializer.for(AccountClosedEvent));

		const accountId = AccountId.generate();

		const openedEvent = new AccountOpenedEvent(new Date());
		const creditedEvent = new AccountCreditedEvent(100);
		const debitedEvent = new AccountDebitedEvent(50);
		const closedEvent = new AccountClosedEvent(new Date());

		const envelopes = eventMap.createEnvelopes(accountId, 4, [openedEvent, creditedEvent, debitedEvent, closedEvent]);

		expect(envelopes).toHaveLength(4);

		expect(envelopes[0].eventId).toBeDefined();
		expect(envelopes[0].eventName).toBe('account-opened');
		expect(envelopes[0].payload).toEqual({ opened: openedEvent.opened });
		expect(envelopes[0].metadata.aggregateId).toBe(accountId.value);
		expect(envelopes[0].metadata.sequence).toBe(1);
		expect(envelopes[0].metadata.occurredOn).toBeDefined();

		expect(envelopes[1].eventId).toBeDefined();
		expect(envelopes[1].eventName).toBe('account-credited');
		expect(envelopes[1].payload).toEqual({ amount: creditedEvent.amount });
		expect(envelopes[1].metadata.aggregateId).toBe(accountId.value);
		expect(envelopes[1].metadata.sequence).toBe(2);
		expect(envelopes[1].metadata.occurredOn).toBeDefined();

		expect(envelopes[2].eventId).toBeDefined();
		expect(envelopes[2].eventName).toBe('account-debited');
		expect(envelopes[2].payload).toEqual({ amount: debitedEvent.amount });
		expect(envelopes[2].metadata.aggregateId).toBe(accountId.value);
		expect(envelopes[2].metadata.sequence).toBe(3);
		expect(envelopes[2].metadata.occurredOn).toBeDefined();

		expect(envelopes[3].eventId).toBeDefined();
		expect(envelopes[3].eventName).toBe('account-closed');
		expect(envelopes[3].payload).toEqual({ closed: closedEvent.closed });
		expect(envelopes[3].metadata.aggregateId).toBe(accountId.value);
		expect(envelopes[3].metadata.sequence).toBe(4);
		expect(envelopes[3].metadata.occurredOn).toBeDefined();
	});
});
