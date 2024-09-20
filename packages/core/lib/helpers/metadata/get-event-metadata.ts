import type { Type } from '@nestjs/common';
import { EVENT_METADATA } from '../../decorators';
import type { EventMetadata, IEvent } from '../../interfaces';

export const getEventMetadata = (event: Type<IEvent>): EventMetadata => {
	return Reflect.getMetadata(EVENT_METADATA, event) ?? {};
};
