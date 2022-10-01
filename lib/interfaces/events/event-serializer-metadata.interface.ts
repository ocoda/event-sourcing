import { Type } from '@nestjs/common';
import { IEvent } from './event.interface';

export interface EventSerializerMetadata {
	event: Type<IEvent>;
}
