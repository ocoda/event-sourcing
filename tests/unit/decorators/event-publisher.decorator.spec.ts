import { EventPublisher, IEventPublisher } from '../../../lib';
import { getEventPublisherMetadata } from '../../../lib/helpers';

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
