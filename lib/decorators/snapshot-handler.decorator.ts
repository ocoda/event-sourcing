import { IEvent } from '../interfaces';
import 'reflect-metadata';
import { SNAPSHOT_HANDLER_METADATA } from './constants';
import { Aggregate } from '../models';
import { Type } from '@nestjs/common';

/**
 * Decorator that marks a class as a snapshot handler. A snapshot handler
 * is responsible for serializing an aggregate's state into to a plain object snapshot
 * and vice versa.
 *
 * The decorated class must implement the `ISnapshotHandler` interface.
 *
 * @param aggregate aggregate *type* to be handled by this handler.
 */
export const SnapshotHandler = <T extends Type<Aggregate>>(
  aggregate: T,
): ClassDecorator => {
  return (target: object) => {
    Reflect.defineMetadata(SNAPSHOT_HANDLER_METADATA, aggregate, target);
  };
};
