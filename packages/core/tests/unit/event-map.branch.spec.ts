import { JsonEventSerializer, Event, EventMap, type IEvent, UnregisteredEventException } from '@ocoda/event-sourcing';

describe(EventMap, () => {
	@Event('billing-updated')
	class BillingUpdatedEvent implements IEvent {
		constructor(public readonly amount: number) {}
	}

	it('throws when checking an unregistered event instance', () => {
		const eventMap = new EventMap();

		expect(() => eventMap.getConstructor(new BillingUpdatedEvent(10))).toThrow(
			new UnregisteredEventException({ event: 'BillingUpdatedEvent' }),
		);
	});

	it('serializes using a registered serializer', () => {
		const eventMap = new EventMap();
		eventMap.register(BillingUpdatedEvent, JsonEventSerializer.for(BillingUpdatedEvent));

		const payload = eventMap.serializeEvent(new BillingUpdatedEvent(42));
		expect(payload.amount).toBe(42);
	});
});
