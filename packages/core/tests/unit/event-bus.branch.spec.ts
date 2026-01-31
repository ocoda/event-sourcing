import { EventBus } from '@ocoda/event-sourcing';
import type { EventEnvelope } from '@ocoda/event-sourcing';

describe(EventBus, () => {
	it('binds subscribers without a name to the main stream', () => {
		const bus = new EventBus();
		const handler = { handle: jest.fn() };
		const spy = jest.spyOn(bus, 'ofEventName' as never);

		bus.bind(handler, '');
		bus.publish({ event: 'test', payload: {}, metadata: {} } as EventEnvelope);

		expect(spy).not.toHaveBeenCalled();
		expect(handler.handle).toHaveBeenCalledTimes(1);
		expect(handler.handle).toHaveBeenCalledWith({ event: 'test', payload: {}, metadata: {} });
	});

	it('publishes to all registered publishers', () => {
		const bus = new EventBus();
		const publisher = { publish: jest.fn() };
		const envelope = { event: 'test', payload: {}, metadata: {} } as EventEnvelope;

		bus.addPublisher(publisher);
		bus.publish(envelope);

		expect(publisher.publish).toHaveBeenCalledWith(envelope);
	});

	it('cleans up subscriptions on module destroy', () => {
		const bus = new EventBus();
		const handler = { handle: jest.fn() };
		const unsubscribe = jest.fn();

		bus.bind(handler, '');
		(bus as any).subscriptions.push({ unsubscribe } as any);
		bus.onModuleDestroy();

		expect(unsubscribe).toHaveBeenCalled();
	});
});
