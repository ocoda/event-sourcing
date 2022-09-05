import { Aggregate } from '@ocoda/event-sourcing/models';
import { ISnapshot } from './snapshot.interface';

export interface ISnapshotHandler<
  A extends Aggregate = Aggregate,
  Payload extends Record<string, any> = Record<string, any>,
> {
  saveSnapshot(aggregate: A): Promise<void>;
  loadFromSnapshot(aggregate: A): Promise<void>;
  serialize: (snapshot: ISnapshot<A>) => Payload;
  deserialize: (payload: Payload, ...params) => ISnapshot<A>;
}
