import type { ISnapshotCollection } from '../interfaces';

export class SnapshotCollection {
	static get(pool?: string): ISnapshotCollection {
		return pool ? `${pool}-snapshots` : 'snapshots';
	}
}
