import { Type } from '@nestjs/common';
import { EventStoreDriver } from './event-store.interface';

export interface EventStoreConfig {
	driver: Type<EventStoreDriver>;
}
