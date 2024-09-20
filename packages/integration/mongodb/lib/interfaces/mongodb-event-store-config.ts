import type { Type } from '@nestjs/common';
import type { EventStoreConfig } from '@ocoda/event-sourcing';
import type { MongoClientOptions } from 'mongodb';
import type { MongoDBEventStore } from '../mongodb.event-store';

export interface MongoDBEventStoreConfig extends EventStoreConfig, MongoClientOptions {
	driver: Type<MongoDBEventStore>;
	url: string;
}
