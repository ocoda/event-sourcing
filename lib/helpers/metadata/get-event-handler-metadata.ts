import { EVENT_HANDLER_METADATA } from '../../decorators';
import { EventHandlerMetadata } from '../../interfaces';

export const getEventHandlerMetadata = (eventHandler: Function): EventHandlerMetadata => {
	return Reflect.getMetadata(EVENT_HANDLER_METADATA, eventHandler) ?? {};
};
