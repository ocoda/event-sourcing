import type { Type } from '@nestjs/common';
import { EVENT_SERIALIZER_METADATA } from '../../decorators';
import type { EventSerializerMetadata, IEventSerializer } from '../../interfaces';

export const getEventSerializerMetadata = (eventSerializer: Type<IEventSerializer>): EventSerializerMetadata => {
	return Reflect.getMetadata(EVENT_SERIALIZER_METADATA, eventSerializer) ?? {};
};
