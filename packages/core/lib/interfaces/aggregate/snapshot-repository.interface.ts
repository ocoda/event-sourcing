import type { AggregateRoot } from '../../models';
import type { ISnapshot } from './snapshot.interface';

export interface ISnapshotRepository<A extends AggregateRoot> {
	serialize(aggregate: A): ISnapshot<A>;
	deserialize(payload: ISnapshot<A>): A;
}
