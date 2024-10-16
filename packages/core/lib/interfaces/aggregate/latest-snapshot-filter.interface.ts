import type { ISnapshotFilter } from './snapshot-filter.interface';

export interface ILatestSnapshotFilter extends Pick<ISnapshotFilter, 'batch' | 'limit' | 'pool'> {
	aggregateId?: string;
}
