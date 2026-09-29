import type { Type } from '@nestjs/common';
import { EVENT_HANDLER_METADATA } from '../../decorators/index.js';
import type { EventHandlerMetadata, IEvent } from '../../interfaces/index.js';
import type { AggregateRoot } from '../../models/index.js';
import { getEventMetadata } from './get-event-metadata.js';

export const getEventHandlerMetadata = (aggregate: AggregateRoot, eventClass: Type<IEvent>): EventHandlerMetadata => {
	const { name } = getEventMetadata(eventClass);
	return Reflect.getMetadata(`${EVENT_HANDLER_METADATA}-${name}`, aggregate) || {};
};
