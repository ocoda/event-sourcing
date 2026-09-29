import type { Type } from '@nestjs/common';
import { EventSubscriber, type IEvent, type IEventSubscriber, getEventSubscriberMetadata } from '@ocoda/event-sourcing';

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

	it('takes event classes (ADR 0001 §7)', () => {
		// Never called: checked by the compiler only.
		const compileTimeOnly = () => {
			// @ts-expect-error an event name is not an event class
			@EventSubscriber('FooEvent')
			class _NameSubscriber implements IEventSubscriber {
				async handle() {}
			}

			// @ts-expect-error an event instance is not an event class
			@EventSubscriber(FooEvent, new BarEvent())
			class _InstanceSubscriber implements IEventSubscriber {
				async handle() {}
			}
		};

		expectTypeOf(compileTimeOnly).toBeFunction();
		expectTypeOf(EventSubscriber).parameters.toEqualTypeOf<Type<IEvent>[]>();
	});
});
