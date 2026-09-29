import type { Type } from '@nestjs/common';
import type { EventStoreConfig, SchemaOptions } from '@ocoda/event-sourcing';
import type { PoolConfig } from 'pg';
import type { PostgresEventStore } from '../postgres.event-store.js';

/**
 * The config of the `PostgresEventStore`: the `pg` pool config, plus the store's own options. The store strips the
 * options that aren't the pool's (`ddl`, `useDefaultPool`) before it creates the pool.
 */
export interface PostgresEventStoreConfig extends EventStoreConfig, SchemaOptions, PoolConfig {
	driver: Type<PostgresEventStore>;
}
