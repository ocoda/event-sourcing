import { Type } from '@nestjs/common';
import { Aggregate } from '../../aggregate';
import { Id } from '../../id';
import { IEvent } from '..';

export interface IEventStore<AggregateBase extends Aggregate = Aggregate> {
  getEvents(
    aggregate: Type<AggregateBase>,
    id: Id,
    fromVersion?: number,
  ): IEvent[] | Promise<IEvent[]>;
  getEvent(version: number): IEvent | Promise<IEvent>;
  store(...events: IEvent[]): void | Promise<void>;
}
