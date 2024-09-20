import type { ISnapshotCollection } from './snapshot-collection.type';
import type { ISnapshotPool } from './snapshot-pool.type';

export interface SnapshotStoreDriver {
	connect(): void | Promise<void>;
	disconnect(): void | Promise<void>;
	ensureCollection(pool?: ISnapshotPool): ISnapshotCollection | Promise<ISnapshotCollection>;
}
