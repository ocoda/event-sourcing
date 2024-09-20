import { ISnapshotFilter } from './snapshot-filter.interface';

export interface ILatestSnapshotFilter extends Pick<ISnapshotFilter, 'batch' | 'limit' | 'pool'> {
	fromId?: string;
}
