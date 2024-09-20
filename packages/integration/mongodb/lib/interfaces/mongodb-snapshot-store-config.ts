import { Type } from '@nestjs/common';
import { SnapshotStoreConfig } from '@ocoda/event-sourcing';
import { MongoClientOptions } from 'mongodb';
import { MongoDBSnapshotStore } from '../mongodb.snapshot-store';

export interface MongoDBSnapshotStoreConfig extends SnapshotStoreConfig, MongoClientOptions {
	driver: Type<MongoDBSnapshotStore>;
	url: string;
}
