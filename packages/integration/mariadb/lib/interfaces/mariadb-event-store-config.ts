import { Type } from '@nestjs/common';
import { EventStoreConfig } from '@ocoda/event-sourcing';
import { PoolConfig } from 'mariadb';
import { MariaDBEventStore } from '../mariadb-event-store';

export interface MariaDBEventStoreConfig extends EventStoreConfig, PoolConfig {
	driver: Type<MariaDBEventStore>;
}
