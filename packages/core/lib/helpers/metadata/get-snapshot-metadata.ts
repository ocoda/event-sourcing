import type { Type } from '@nestjs/common';
import { SNAPSHOT_METADATA } from '../../decorators';
import type { ISnapshotHandler, SnapshotMetadata } from '../../interfaces';
import type { AggregateRoot } from '../../models';

export const getSnapshotMetadata = <A extends AggregateRoot>(
	snapshotHandler: Type<ISnapshotHandler<A>>,
): SnapshotMetadata<A> => {
	return Reflect.getMetadata(SNAPSHOT_METADATA, snapshotHandler) ?? {};
};
