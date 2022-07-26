import 'reflect-metadata';
import { SNAPSHOT_METADATA } from './constants';
import { SnapshotMetadata } from "../interfaces";

/**
 * Decorator indicates that an aggregate should store snapshots.
 *
 * The decorated class must extend the `Aggregate` class.
 *
 * @param metadata snapshot configuration metadata.
 */
export const Snapshot = (metadata: SnapshotMetadata): ClassDecorator => {
  return (target: object) => {
    Reflect.defineMetadata(SNAPSHOT_METADATA, metadata, target);
  };
};
