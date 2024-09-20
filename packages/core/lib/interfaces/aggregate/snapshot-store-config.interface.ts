import type { Type } from '@nestjs/common';
import type { SnapshotStoreDriver } from './snapshot-store.interface';

export interface SnapshotStoreConfig {
	driver: Type<SnapshotStoreDriver>;
	/**
	 * Creates a snapshot collection with the default pool name ('snapshots').
	 * For multi-tenant setups, you can provide a pool name to separate snapshots with `snapshotStore.ensureCollection(pool?: ISnapshotPool)`.
	 * @default true
	 */
	useDefaultPool?: boolean;
}
