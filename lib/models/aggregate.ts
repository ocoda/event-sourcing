import { Type } from '@nestjs/common';
import { IEvent, ISnapshot } from '../interfaces';

const EVENTS = Symbol();
const USE_SNAPSHOTS = Symbol();

export abstract class Aggregate<EventBase extends IEvent = IEvent> {
  private _version: number = 0;
  private readonly [USE_SNAPSHOTS] = false;
  private readonly [EVENTS]: EventBase[] = [];

  set version(version: number) {
    this._version = version;
  }

  get version(): number {
    return this._version;
  }

  apply<T extends EventBase = EventBase>(event: T, fromHistory = false) {
    this._version++;

    // If we're just hydrating the aggregate with events,
    // don't push the event to the internal event collection to be committed
    if (!fromHistory) {
      this[EVENTS].push(event);
    }

    const handler = this.getEventHandler(event);
    handler && handler.call(this, event);
  }

  private getEventHandler<T extends EventBase = EventBase>(
    event: T,
  ): Type<typeof Aggregate> | undefined {
    const handler = `on${this.getEventName(event)}`;
    return this[handler];
  }

  private getEventName(event: EventBase): string {
    const { constructor } = Object.getPrototypeOf(event);
    return constructor.name;
  }

  commit(): IEvent[] {
    const events = [...this[EVENTS]];
    this[EVENTS].length = 0;

    return events;
  }

  loadFromHistory(events: EventBase[]) {
    events.forEach((event) => this.apply(event, true));
  }
}
