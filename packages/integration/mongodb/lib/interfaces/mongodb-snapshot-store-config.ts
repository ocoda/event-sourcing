import type { Type } from '@nestjs/common';
import type { SnapshotStoreConfig } from '@ocoda/event-sourcing';
import type { MongoClientOptions } from 'mongodb';
import type { MongoDBSnapshotStore } from '../mongodb.snapshot-store';

export interface MongoDBSnapshotStoreConfig extends SnapshotStoreConfig, MongoClientOptions {
	driver: Type<MongoDBSnapshotStore>;
	url: string;
}
