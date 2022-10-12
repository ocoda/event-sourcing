import { SNAPSHOT_METADATA } from '../decorators';
import { SnapshotMetadata } from '../interfaces';
import { AggregateRoot } from '../models';

export const getSnapshotMetadata = <A extends AggregateRoot>(snapshotHandler: Function): SnapshotMetadata<A> => {
	return Reflect.getMetadata(SNAPSHOT_METADATA, snapshotHandler) ?? {};
};
