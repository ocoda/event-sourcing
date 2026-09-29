import type { SnapshotStore } from '../../snapshot-store.js';

/**
 * The class of a snapshot store. The module creates the store with `new driver(options)`, where `options` is the
 * `snapshotStore` configuration without its `driver`.
 */
export type SnapshotStoreDriver<TOptions = any> = new (options: TOptions) => SnapshotStore<TOptions>;
