import type { AggregateRoot } from '../../models/index.js';
import type { ISnapshot } from './snapshot.interface.js';

export interface ISnapshotRepository<A extends AggregateRoot> {
	serialize(aggregate: A): ISnapshot<A>;
	deserialize(payload: ISnapshot<A>): A;
}
