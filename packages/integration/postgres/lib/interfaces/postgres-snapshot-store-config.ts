import type { Type } from '@nestjs/common';
import type { SchemaOptions, SnapshotStoreConfig } from '@ocoda/event-sourcing';
import type { PoolConfig } from 'pg';
import type { PostgresSnapshotStore } from '../postgres.snapshot-store.js';

/**
 * The config of the `PostgresSnapshotStore`: the `pg` pool config, plus the store's own options. The store strips the
 * options that aren't the pool's (`ddl`, `useDefaultPool`) before it creates the pool.
 */
export interface PostgresSnapshotStoreConfig extends SnapshotStoreConfig, SchemaOptions, PoolConfig {
	driver: Type<PostgresSnapshotStore>;
}
