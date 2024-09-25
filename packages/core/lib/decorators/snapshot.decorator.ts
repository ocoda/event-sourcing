import type { Type } from '@nestjs/common';
import 'reflect-metadata';
import type { SnapshotMetadata } from '../interfaces';
import type { AggregateRoot } from '../models';
import { SNAPSHOT_METADATA } from './constants';

/**
 * Decorator that marks a class as a snapshot handler. A snapshot handler is responsible for:
 * - converting an aggregate's state into to a serialized format and vice versa.
 * - saving and loading snapshots from the snapshot store.
 * @description The decorated class must implement the `ISnapshotHandler` interface.
 * @param {Type<A extends AggregateRoot>} aggregate The aggregate constructor for which the instances need to be handled by this handler. Needs to extend the AggregateRoot class.
 * @param { Omit<SnapshotMetadata<A>, 'aggregate'>} options The metadata for the snapshot handler.
 * @returns {ClassDecorator}
 * @example `@Snapshot(Account, { name: 'account', interval: 5 })`
 */
export const Snapshot = <A extends AggregateRoot = AggregateRoot>(
	aggregate: Type<A>,
	options?: Omit<SnapshotMetadata<A>, 'aggregate'>,
): ClassDecorator => {
	return (target: object) => {
		Reflect.defineMetadata(
			SNAPSHOT_METADATA,
			{
				aggregate,
				name: options?.name || aggregate.name.toLowerCase(),
				interval: options?.interval || 10,
			},
			target,
		);
	};
};
