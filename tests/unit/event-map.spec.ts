import {
	Event,
	EventMap,
	IEvent,
	MissingEventMetadataException,
	UnregisteredEventException,
	UnregisteredSerializerException,
} from '../../lib';
import { DefaultEventSerializer } from '../../lib/helpers';

describe(EventMap, () => {
	const now = new Date();

	@Event('account-opened') class AccountOpenedEvent implements IEvent {
		constructor(public readonly opened: Date) {}
	}

	class UnregisteredEvent implements IEvent {}

	beforeAll(() => jest.useFakeTimers({ now }));

	afterAll(() => jest.useRealTimers());

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
		expect(eventMap.has(new AccountOpenedEvent(new Date()))).toBe(true);

		expect(eventMap.has('unregistered-event')).toBe(false);
		expect(eventMap.has(UnregisteredEvent)).toBe(false);
	});

	it('returns the constructor of a registered event by its name or an instance', () => {
		const eventMap = new EventMap();
		eventMap.register(AccountOpenedEvent);

		expect(eventMap.getConstructor('account-opened')).toBe(AccountOpenedEvent);
		expect(eventMap.getConstructor(new AccountOpenedEvent(new Date()))).toBe(AccountOpenedEvent);
	});

	it('throws when trying to get the constructor of an unregistered event by its name or an instance', () => {
		const eventMap = new EventMap();

		expect(() => eventMap.getConstructor('unregistered-event')).toThrowError(
			new UnregisteredEventException('unregistered-event'),
		);
		expect(() => eventMap.getConstructor(new UnregisteredEvent())).toThrowError(
			new UnregisteredEventException('UnregisteredEvent'),
		);
	});

	it('returns the name of a registered event by its constructor or an instance', () => {
		const eventMap = new EventMap();
		eventMap.register(AccountOpenedEvent);

		expect(eventMap.getName(AccountOpenedEvent)).toBe('account-opened');
		expect(eventMap.getName(new AccountOpenedEvent(new Date()))).toBe('account-opened');
	});

	it('throws when trying to get the name of an unregistered event by its constructor or an instance', () => {
		const eventMap = new EventMap();

		expect(() => eventMap.getName(UnregisteredEvent)).toThrowError(new UnregisteredEventException(UnregisteredEvent));
		expect(() => eventMap.getName(new UnregisteredEvent())).toThrowError(
			new UnregisteredEventException(new UnregisteredEvent()),
		);
	});

	it('serializes a registered event', () => {
		const eventMap = new EventMap();
		eventMap.register(AccountOpenedEvent, DefaultEventSerializer.for(AccountOpenedEvent));

		const event = new AccountOpenedEvent(new Date());
		const payload = eventMap.serializeEvent<AccountOpenedEvent>(event);

		expect(payload).toBeInstanceOf(Object);
		expect(payload).toEqual(event);
	});

	it('throws when trying to serialize an event when no serializer was registered', () => {
		const eventMap = new EventMap();
		eventMap.register(AccountOpenedEvent);

		const event = new AccountOpenedEvent(new Date());

		expect(() => eventMap.serializeEvent(event)).toThrowError(new UnregisteredSerializerException('account-opened'));
	});

	it('deserializes a registered event', () => {
		const eventMap = new EventMap();
		eventMap.register(AccountOpenedEvent, DefaultEventSerializer.for(AccountOpenedEvent));

		const payload = { opened: new Date() };
		const event = eventMap.deserializeEvent<AccountOpenedEvent>('account-opened', payload);

		expect(event).toBeInstanceOf(AccountOpenedEvent);
		expect(event).toEqual(event);
	});

	it('throws when trying to deserialize an event when no serializer was registered', () => {
		const eventMap = new EventMap();
		eventMap.register(AccountOpenedEvent);

		const payload = { opened: new Date() };

		expect(() => eventMap.deserializeEvent('account-opened', payload)).toThrowError(
			new UnregisteredSerializerException('account-opened'),
		);
	});
});
