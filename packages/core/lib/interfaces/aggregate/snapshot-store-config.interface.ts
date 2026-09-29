import type { SnapshotStoreDriver } from './snapshot-store.interface.js';

export interface SnapshotStoreConfig {
	driver: SnapshotStoreDriver;
	/**
	 * Creates a snapshot collection with the default pool name ('snapshots').
	 * For multi-tenant setups, you can provide a pool name to separate snapshots with `snapshotStore.ensureCollection(pool?: ISnapshotPool)`.
	 * @default true
	 */
	useDefaultPool?: boolean;
}
