import { Type } from '@nestjs/common';
import { EventStoreConfig } from '@ocoda/event-sourcing';
import { MongoClientOptions } from 'mongodb';
import { MongoDBEventStore } from '../mongodb.event-store';

export interface MongoDBEventStoreConfig extends EventStoreConfig, MongoClientOptions {
	driver: Type<MongoDBEventStore>;
	url: string;
}
