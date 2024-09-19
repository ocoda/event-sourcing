import { Type } from '@nestjs/common';
import { SnapshotStoreDriver } from './snapshot-store.interface';

export interface SnapshotStoreConfig {
	driver: Type<SnapshotStoreDriver>;
}
