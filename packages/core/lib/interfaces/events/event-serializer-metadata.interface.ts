import type { Type } from '@nestjs/common';
import type { IEvent } from './event.interface';

export interface EventSerializerMetadata {
	event: Type<IEvent>;
}
