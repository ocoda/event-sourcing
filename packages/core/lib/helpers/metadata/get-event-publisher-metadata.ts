import type { Type } from '@nestjs/common';
import { EVENT_PUBLISHER_METADATA } from '../../decorators/index.js';
import type { EventPublisherMetadata, IEventPublisher } from '../../interfaces/index.js';

export const getEventPublisherMetadata = (eventPublisher: Type<IEventPublisher>): EventPublisherMetadata => {
	return Reflect.getMetadata(EVENT_PUBLISHER_METADATA, eventPublisher) ?? {};
};
