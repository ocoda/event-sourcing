import { Type } from '@nestjs/common';
import { IEvent } from './interfaces';

export abstract class Aggregate<EventBase extends IEvent = IEvent> {
  apply<T extends EventBase = EventBase>(event: T) {
    const handler = this.getEventHandler(event);
    handler && handler.call(this, event);
  }

  protected getEventHandler<T extends EventBase = EventBase>(
    event: T,
  ): Type<typeof Aggregate> | undefined {
    const handler = `on${this.getEventName(event)}`;
    return this[handler];
  }

  protected getEventName(event: any): string {
    const { constructor } = Object.getPrototypeOf(event);
    return constructor.name;
  }
}
