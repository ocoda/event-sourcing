import { Type } from '@nestjs/common';
import { Subject } from 'rxjs';
import { Aggregate } from '../aggregate';
import { EventEnvelope } from '../event-envelope';
import { Id } from '../id';
import { IEvent, IEventStore } from '../interfaces';

type EventStream = `${string}-${string}`;

export class DefaultEventStore implements IEventStore {
  private eventCollection: Map<EventStream, EventEnvelope[]> = new Map();

  getEvents(
    aggregate: Type<Aggregate>,
    id: Id,
    fromVersion?: number,
  ): IEvent[] | Promise<IEvent[]> {
    throw new Error('Method not implemented.');
  }
  getEvent(version: number): IEvent | Promise<IEvent> {
    throw new Error('Method not implemented.');
  }

  store(...events: IEvent[]): void {
    events.forEach((event) => {
      const stream = this.getEventStream(event);
      this.store[stream] = event;
    });
  }

  private getEventStream(aggregate: Type<Aggregate>, id: Id): EventStream {
    return `${aggregate.constructor.name}-${id.value}`;
  }
}
