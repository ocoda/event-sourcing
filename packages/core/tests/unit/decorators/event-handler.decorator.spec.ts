import { Aggregate, AggregateRoot, EventHandler, MissingEventMetadataException } from '@ocoda/event-sourcing';
import { Event, type IEvent } from '@ocoda/event-sourcing';
import { getEventHandlerMetadata } from '@ocoda/event-sourcing/helpers';

describe('@EventHandler', () => {
	@Event()
	class FooEvent implements IEvent {}

	@Event('bar')
	class BarEvent implements IEvent {}

	@Event()
	class FooBarEvent implements IEvent {}

	@Aggregate()
	class TestAggregate extends AggregateRoot {
		@EventHandler(FooEvent)
		applyFooEvent() {}

		@EventHandler(BarEvent)
		iCanBeNamedWhatever() {}
	}

	it('should mark an aggregate method as an event-handler', () => {
		const aggregate = new TestAggregate();

		const { method: fooHandler } = getEventHandlerMetadata(aggregate, FooEvent);
		expect(fooHandler).toBe(aggregate.applyFooEvent.name);

		const { method: barHandler } = getEventHandlerMetadata(aggregate, BarEvent);
		expect(barHandler).toBe(aggregate.iCanBeNamedWhatever.name);

		const { method: fooBarHandler } = getEventHandlerMetadata(aggregate, FooBarEvent);
		expect(fooBarHandler).toBeUndefined();
	});

	it('should throw an error if an undecorated event is provided', () => {
		expect(() => {
			class UndecoratedEvent implements IEvent {}

			@Aggregate()
			class InvalidHandlerAggregate extends AggregateRoot {
				@EventHandler(UndecoratedEvent)
				applyUndecoratedEvent() {}
			}
		}).toThrow(MissingEventMetadataException);
	});
});
