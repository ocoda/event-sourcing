import { Type } from '@nestjs/common';
import { EventStoreConfig } from '@ocoda/event-sourcing';
import { PoolConfig } from 'pg';
import { PostgresEventStore } from '../postgres-event-store';

export interface PostgresEventStoreConfig extends EventStoreConfig, PoolConfig {
	driver: Type<PostgresEventStore>;
}
