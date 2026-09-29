import type { ISnapshotCollection } from '../interfaces/index.js';

export class SnapshotCollection {
	static get(pool?: string): ISnapshotCollection {
		return pool ? `${pool}-snapshots` : 'snapshots';
	}
}
