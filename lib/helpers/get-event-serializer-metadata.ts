import { EVENT_SERIALIZER_METADATA } from '../decorators';
import { EventSerializerMetadata } from '../interfaces';

export const getEventSerializerMetadata = (eventSerializer: Function): EventSerializerMetadata => {
	return Reflect.getMetadata(EVENT_SERIALIZER_METADATA, eventSerializer) ?? {};
};
