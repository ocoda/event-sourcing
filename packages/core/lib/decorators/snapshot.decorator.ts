import { Type } from '@nestjs/common';
import 'reflect-metadata';
import { SnapshotMetadata } from '../interfaces';
import { AggregateRoot } from '../models';
import { SNAPSHOT_METADATA } from './constants';

/**
 * Decorator that marks a class as a snapshot handler. A snapshot handler
 * is responsible for:
 * - serializing an aggregate's state into to a plain object snapshot and vice versa.
 * - saving and loading snapshots from the snapshot store.
 *
 * The decorated class must implement the `ISnapshotHandler` interface.
 *
 * @param aggregate aggregate *type* to be handled by this handler.
 * @param options snapshot metadata.
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
