import { IEvent } from '../interfaces';
import 'reflect-metadata';
import { SNAPSHOT_SERIALIZER_METADATA } from './constants';
import { Aggregate } from '../models';
import { Type } from '@nestjs/common';

/**
 * Decorator that marks a class as a snapshot serializer. A snapshot serializer
 * is responsible for turning an aggregate into to a plain object and vice versa.
 *
 * The decorated class must implement the `ISnapshotSerializer` interface.
 *
 * @param aggregate aggregate *type* to be handled by this serializer.
 */
export const SnapshotSerializer = <T extends Type<Aggregate>>(
  aggregate: T,
): ClassDecorator => {
  return (target: object) => {
    Reflect.defineMetadata(SNAPSHOT_SERIALIZER_METADATA, aggregate, target);
  };
};
