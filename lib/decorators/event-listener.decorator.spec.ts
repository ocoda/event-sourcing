import { IEvent } from '../interfaces';
import { EVENT_LISTENER_METADATA } from './constants';
import { EventListener } from './event-listener.decorator';

describe('@EventListener', () => {
	class TestCreatedEvent implements IEvent {}
	class TestUpdatedEvent implements IEvent {}

	class EventHandler {
		@EventListener(TestCreatedEvent)
		static onTestCreated() {
			return;
		}

		@EventListener(TestUpdatedEvent)
		static onTestUpdated() {
			return;
		}
	}

	it('should specify which event the event-handler method listens to', () => {
		const onTestCreatedEvent: string = Reflect.getMetadata(EVENT_LISTENER_METADATA, EventHandler.onTestCreated);
		expect(onTestCreatedEvent).toEqual({
			event: 'TestCreatedEvent',
			options: undefined,
		});

		const onTestUpdatedEvent: string = Reflect.getMetadata(EVENT_LISTENER_METADATA, EventHandler.onTestUpdated);
		expect(onTestUpdatedEvent).toEqual({
			event: 'TestUpdatedEvent',
			options: undefined,
		});
	});
});
