import type { Type } from '@nestjs/common';
import { EVENT_SUBSCRIBER_METADATA } from '../../decorators';
import type { EventSubscriberMetadata, IEventSubscriber } from '../../interfaces';

export const getEventSubscriberMetadata = (eventSubscriber: Type<IEventSubscriber>): EventSubscriberMetadata => {
	return Reflect.getMetadata(EVENT_SUBSCRIBER_METADATA, eventSubscriber) ?? {};
};
