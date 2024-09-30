import { EventSubscriber, type IEvent, type IEventSubscriber } from '@ocoda/event-sourcing';
import { getEventSubscriberMetadata } from '@ocoda/event-sourcing/helpers';

describe('@EventSubscriber', () => {
	class FooEvent implements IEvent {}
	class BarEvent implements IEvent {}

	@EventSubscriber(FooEvent)
	class FooEventSubscriber implements IEventSubscriber {
		async handle() {}
	}

	@EventSubscriber(BarEvent)
	class BarEventSubscriber implements IEventSubscriber {
		async handle() {}
	}

	@EventSubscriber(FooEvent, BarEvent)
	class FooBarEventSubscriber implements IEventSubscriber {
		async handle() {}
	}

	it('should specify which events the event-subscriber handles', () => {
		const { events: fooEvents } = getEventSubscriberMetadata(FooEventSubscriber);
		expect(fooEvents).toEqual([FooEvent]);

		const { events: barEvents } = getEventSubscriberMetadata(BarEventSubscriber);
		expect(barEvents).toEqual([BarEvent]);

		const { events: fooBarEvents } = getEventSubscriberMetadata(FooBarEventSubscriber);
		expect(fooBarEvents).toEqual([FooEvent, BarEvent]);
	});
});
