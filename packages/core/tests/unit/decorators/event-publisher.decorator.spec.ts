import { EventPublisher, type IEventPublisher, getEventPublisherMetadata } from '@ocoda/event-sourcing';

describe('@EventPublisher', () => {
	@EventPublisher()
	class CustomEventPublisher implements IEventPublisher {
		publish() {}
	}

	it('should mark a class as an event-publisher', () => {
		const { id } = getEventPublisherMetadata(CustomEventPublisher);
		expect(id).toBeDefined();
	});
});
