import type { Type } from '@nestjs/common';
import { EVENT_HANDLER_METADATA } from '../../decorators';
import type { EventHandlerMetadata, IEvent } from '../../interfaces';
import type { AggregateRoot } from '../../models';
import { getEventMetadata } from './get-event-metadata';

export const getEventHandlerMetadata = (aggregate: AggregateRoot, eventClass: Type<IEvent>): EventHandlerMetadata => {
	const { name } = getEventMetadata(eventClass);
	return Reflect.getMetadata(`${EVENT_HANDLER_METADATA}-${name}`, aggregate) || {};
};
