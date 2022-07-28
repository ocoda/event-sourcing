import { Id } from '../../id';
import { EventEnvelope } from '../../event-envelope';
import { IEvent } from './event.interface';

export interface IEventTransformer<T extends IEvent = IEvent> {
  wrap(aggregateId: Id, sequence: number, event: T): EventEnvelope<T>;
  unwrap(envelope: EventEnvelope<T>): T;
}
