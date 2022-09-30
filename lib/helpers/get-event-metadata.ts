import { EVENT_METADATA } from '../decorators';
import { EventType } from '../event-bus';
import { EventMetadata } from '../interfaces';

export const getEventMetadata = (event: EventType): EventMetadata => {
	return Reflect.getMetadata(EVENT_METADATA, event) ?? {};
};
