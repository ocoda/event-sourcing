import type { Type } from '@nestjs/common';
import type { SnapshotStoreConfig } from '@ocoda/event-sourcing';
import type { RedisClientOptions, RedisFunctions, RedisModules, RedisScripts } from '@redis/client';
import type { RedisSnapshotStore } from '../redis.snapshot-store';

export interface RedisSnapshotStoreConfig
	extends SnapshotStoreConfig,
		RedisClientOptions<RedisModules, RedisFunctions, RedisScripts> {
	driver: Type<RedisSnapshotStore>;
}
