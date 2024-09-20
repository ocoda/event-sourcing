import { Type } from '@nestjs/common';
import { SnapshotStoreConfig } from '@ocoda/event-sourcing';
import { PoolConfig } from 'mariadb';
import { MariaDBSnapshotStore } from '../mariadb.snapshot-store';

export interface MariaDBSnapshotStoreConfig extends SnapshotStoreConfig, PoolConfig {
	driver: Type<MariaDBSnapshotStore>;
}
