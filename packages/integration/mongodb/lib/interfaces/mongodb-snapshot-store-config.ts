import type { Type } from '@nestjs/common';
import type { SchemaOptions, SnapshotStoreConfig } from '@ocoda/event-sourcing';
import type { MongoClientOptions } from 'mongodb';
import type { MongoDBSnapshotStore } from '../mongodb.snapshot-store.js';

export interface MongoDBSnapshotStoreConfig extends SnapshotStoreConfig, SchemaOptions, MongoClientOptions {
	driver: Type<MongoDBSnapshotStore>;
	/**
	 * The connection string. Its database holds the snapshot collections and their catalog
	 * (`event_sourcing_collections`).
	 */
	url: string;
}
