import { EVENT_PUBLISHER_METADATA } from '../../decorators';
import { EventPublisherMetadata } from '../../interfaces';

export const getEventPublisherMetadata = (eventPublisher: Function): EventPublisherMetadata => {
	return Reflect.getMetadata(EVENT_PUBLISHER_METADATA, eventPublisher) ?? {};
};
