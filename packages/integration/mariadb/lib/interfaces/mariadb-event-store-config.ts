import type { Type } from '@nestjs/common';
import type { EventStoreConfig, SchemaOptions } from '@ocoda/event-sourcing';
import type { PoolConfig } from 'mariadb';
import type { MariaDBEventStore } from '../mariadb.event-store.js';

/**
 * The configuration of a `MariaDBEventStore`: the `mariadb` pool options, and `ddl`, which says whether the store may
 * create its tables (`'auto'`, the default) or only checks them (`'none'`).
 */
export interface MariaDBEventStoreConfig extends EventStoreConfig, PoolConfig, SchemaOptions {
	driver: Type<MariaDBEventStore>;
}
