import { EventPublisher, IEventPublisher } from '@ocoda/event-sourcing';
import { getEventPublisherMetadata } from '@ocoda/event-sourcing/helpers';

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
