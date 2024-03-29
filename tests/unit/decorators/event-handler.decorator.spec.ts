import { EventHandler, IEvent, IEventHandler } from '../../../lib';
import { getEventHandlerMetadata } from '../../../lib/helpers';

describe('@EventHandler', () => {
	class FooEvent implements IEvent {}
	class BarEvent implements IEvent {}

	@EventHandler(FooEvent)
	class FooEventhandler implements IEventHandler {
		async handle() {}
	}

	@EventHandler(BarEvent)
	class BarEventhandler implements IEventHandler {
		async handle() {}
	}

	@EventHandler(FooEvent, BarEvent)
	class FooBarEventhandler implements IEventHandler {
		async handle() {}
	}

	it('should specify which events the event-handler handles', () => {
		const { events: fooEvents } = getEventHandlerMetadata(FooEventhandler);
		expect(fooEvents).toEqual([FooEvent]);

		const { events: barEvents } = getEventHandlerMetadata(BarEventhandler);
		expect(barEvents).toEqual([BarEvent]);

		const { events: fooBarEvents } = getEventHandlerMetadata(FooBarEventhandler);
		expect(fooBarEvents).toEqual([FooEvent, BarEvent]);
	});
});
