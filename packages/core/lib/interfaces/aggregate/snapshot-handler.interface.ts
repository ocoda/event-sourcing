import type { AggregateRoot } from '../../models';
import type { ISnapshot } from './snapshot.interface';

export interface ISnapshotHandler<A extends AggregateRoot> {
	serialize(aggregate: A): ISnapshot<A>;
	deserialize(payload: ISnapshot<A>): A;
}
