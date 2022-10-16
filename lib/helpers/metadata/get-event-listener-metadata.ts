import { EVENT_LISTENER_METADATA } from '../../decorators';
import { EventListenerMetadata } from '../../interfaces';

export const getEventListenerMetadata = (eventListener: Function): EventListenerMetadata => {
	return Reflect.getMetadata(EVENT_LISTENER_METADATA, eventListener) ?? {};
};
