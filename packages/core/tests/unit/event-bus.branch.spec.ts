import { EventBus } from '@ocoda/event-sourcing';
import type { EventEnvelope } from '@ocoda/event-sourcing';

describe(EventBus, () => {
	it('binds subscribers without a name to the main stream', () => {
		const bus = new EventBus();
		const handler = { handle: vi.fn() };
		const spy = vi.spyOn(bus, 'ofEventName' as never);

		bus.bind(handler, '');
		bus.publish({ event: 'test', payload: {}, metadata: {} } as EventEnvelope);

		expect(spy).not.toHaveBeenCalled();
		expect(handler.handle).toHaveBeenCalledTimes(1);
		expect(handler.handle).toHaveBeenCalledWith({ event: 'test', payload: {}, metadata: {} });
	});

	it('publishes to all registered publishers', () => {
		const bus = new EventBus();
		const publisher = { publish: vi.fn() };
		const envelope = { event: 'test', payload: {}, metadata: {} } as EventEnvelope;

		bus.addPublisher(publisher);
		bus.publish(envelope);

		expect(publisher.publish).toHaveBeenCalledWith(envelope);
	});

	it('cleans up subscriptions once the application has shut down', () => {
		const bus = new EventBus();
		const handler = { handle: vi.fn() };
		const unsubscribe = vi.fn();

		bus.bind(handler, '');
		(bus as any).subscriptions.push({ unsubscribe } as any);
		bus.onApplicationShutdown();

		expect(unsubscribe).toHaveBeenCalled();
		expect((bus as any).subscriptions).toEqual([]);
		void bus.publish({ event: 'test', payload: {}, metadata: {} } as EventEnvelope);
		expect(handler.handle).not.toHaveBeenCalled();
	});

	it('keeps the subscriptions until the application has shut down', () => {
		// 3.x unsubscribed in onModuleDestroy, which Nest runs before the bus drains in beforeApplicationShutdown
		expect('onModuleDestroy' in new EventBus()).toBe(false);
	});
});
