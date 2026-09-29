import type { Type } from '@nestjs/common';
import { SNAPSHOT_METADATA } from '../../decorators/index.js';
import type { ISnapshotRepository, SnapshotRepositoryMetadata } from '../../interfaces/index.js';
import type { AggregateRoot } from '../../models/index.js';

export const getSnapshotMetadata = <A extends AggregateRoot>(
	snapshotRepository: Type<ISnapshotRepository<A>>,
): SnapshotRepositoryMetadata<A> => {
	return Reflect.getMetadata(SNAPSHOT_METADATA, snapshotRepository) ?? {};
};
