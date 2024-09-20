import type { Type } from '@nestjs/common';
import type { EventStoreConfig } from '@ocoda/event-sourcing';
import type { PoolConfig } from 'mariadb';
import type { MariaDBEventStore } from '../mariadb.event-store';

export interface MariaDBEventStoreConfig extends EventStoreConfig, PoolConfig {
	driver: Type<MariaDBEventStore>;
}
