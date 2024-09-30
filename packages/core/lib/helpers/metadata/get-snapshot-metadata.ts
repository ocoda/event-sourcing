import type { Type } from '@nestjs/common';
import { SNAPSHOT_METADATA } from '../../decorators';
import type { ISnapshotRepository, SnapshotRepositoryMetadata } from '../../interfaces';
import type { AggregateRoot } from '../../models';

export const getSnapshotMetadata = <A extends AggregateRoot>(
	snapshotRepository: Type<ISnapshotRepository<A>>,
): SnapshotRepositoryMetadata<A> => {
	return Reflect.getMetadata(SNAPSHOT_METADATA, snapshotRepository) ?? {};
};
