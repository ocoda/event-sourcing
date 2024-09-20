import type { Type } from '@nestjs/common';
import type { SnapshotStoreConfig } from '@ocoda/event-sourcing';
import type { PoolConfig } from 'mariadb';
import type { MariaDBSnapshotStore } from '../mariadb.snapshot-store';

export interface MariaDBSnapshotStoreConfig extends SnapshotStoreConfig, PoolConfig {
	driver: Type<MariaDBSnapshotStore>;
}
