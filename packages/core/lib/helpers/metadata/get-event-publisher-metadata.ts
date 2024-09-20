import type { Type } from '@nestjs/common';
import { EVENT_PUBLISHER_METADATA } from '../../decorators';
import type { EventPublisherMetadata, IEventPublisher } from '../../interfaces';

export const getEventPublisherMetadata = (eventPublisher: Type<IEventPublisher>): EventPublisherMetadata => {
	return Reflect.getMetadata(EVENT_PUBLISHER_METADATA, eventPublisher) ?? {};
};
