import { Type } from '@nestjs/common';
import { SnapshotStoreConfig } from '@ocoda/event-sourcing';
import { PoolConfig } from 'pg';
import { PostgresSnapshotStore } from '../postgres-snapshot-store';

export interface PostgresSnapshotStoreConfig extends SnapshotStoreConfig, PoolConfig {
	driver: Type<PostgresSnapshotStore>;
}
