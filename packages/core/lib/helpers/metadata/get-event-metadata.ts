import type { Type } from '@nestjs/common';
import { EVENT_METADATA } from '../../decorators/index.js';
import type { EventMetadata, IEvent } from '../../interfaces/index.js';

export const getEventMetadata = (event: Type<IEvent>): EventMetadata => {
	return Reflect.getMetadata(EVENT_METADATA, event) ?? {};
};
