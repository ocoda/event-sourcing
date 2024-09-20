import type { Type } from '@nestjs/common';
import type { EventStoreConfig } from '@ocoda/event-sourcing';
import type { PoolConfig } from 'pg';
import type { PostgresEventStore } from '../postgres.event-store';

export interface PostgresEventStoreConfig extends EventStoreConfig, PoolConfig {
	driver: Type<PostgresEventStore>;
}
