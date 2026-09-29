import type { Type } from '@nestjs/common';
import type { SchemaOptions, SnapshotStoreConfig } from '@ocoda/event-sourcing';
import type { PoolConfig } from 'mariadb';
import type { MariaDBSnapshotStore } from '../mariadb.snapshot-store.js';

/**
 * The configuration of a `MariaDBSnapshotStore`: the `mariadb` pool options, and `ddl`, which says whether the store
 * may create its tables (`'auto'`, the default) or only checks them (`'none'`).
 */
export interface MariaDBSnapshotStoreConfig extends SnapshotStoreConfig, PoolConfig, SchemaOptions {
	driver: Type<MariaDBSnapshotStore>;
}
