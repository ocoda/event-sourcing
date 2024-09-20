import type { Type } from '@nestjs/common';
import type { SnapshotStoreConfig } from '@ocoda/event-sourcing';
import type { PoolConfig } from 'pg';
import type { PostgresSnapshotStore } from '../postgres.snapshot-store';

export interface PostgresSnapshotStoreConfig extends SnapshotStoreConfig, PoolConfig {
	driver: Type<PostgresSnapshotStore>;
}
