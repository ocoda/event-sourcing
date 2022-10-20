import { Type } from '@nestjs/common';
import { IEvent } from './event.interface';

export interface EventHandlerMetadata {
	events: Type<IEvent>[];
}
