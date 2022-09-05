import { IEvent, SnapshotMetadata } from '../interfaces';
import 'reflect-metadata';
import { SNAPSHOT_METADATA } from './constants';
import { Aggregate } from '../models';
import { Type } from '@nestjs/common';

/**
 * Decorator that marks a class as a snapshot handler. A snapshot handler
 * is responsible for:
 * - serializing an aggregate's state into to a plain object snapshot and vice versa.
 * - saving and loading snapshots from the snapshot store.
 *
 * The decorated class must implement the `ISnapshotHandler` interface.
 *
 * @param aggregate aggregate *type* to be handled by this handler.
 * @param metadata snapshot metadata.
 */
export const Snapshot = (
  aggregate: Type<Aggregate>,
  options?: Omit<SnapshotMetadata, 'aggregate'>,
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
