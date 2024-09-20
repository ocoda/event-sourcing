import type { Type } from '@nestjs/common';
import type { IEvent } from './event.interface';

export interface EventHandlerMetadata {
	events: Type<IEvent>[];
}
