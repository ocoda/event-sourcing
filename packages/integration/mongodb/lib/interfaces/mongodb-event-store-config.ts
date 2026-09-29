import type { Type } from '@nestjs/common';
import type { EventStoreConfig, SchemaOptions } from '@ocoda/event-sourcing';
import type { MongoClientOptions } from 'mongodb';
import type { MongoDBEventStore } from '../mongodb.event-store.js';

export interface MongoDBEventStoreConfig extends EventStoreConfig, SchemaOptions, MongoClientOptions {
	driver: Type<MongoDBEventStore>;
	/**
	 * The connection string. Its database holds the event collections and their catalog (`event_sourcing_collections`).
	 */
	url: string;
}
