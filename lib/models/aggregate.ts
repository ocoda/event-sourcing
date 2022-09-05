import { Type } from '@nestjs/common';
import { IEvent, ISnapshot } from '../interfaces';

const VERSION = Symbol();
const EVENTS = Symbol();

export abstract class Aggregate<EventBase extends IEvent = IEvent> {
  private [VERSION]: number = 0;
  private readonly [EVENTS]: EventBase[] = [];

  get snapshot(): ISnapshot<Aggregate> {
    const snapshot = { version: this[VERSION] };

    for (const prop in this as Aggregate) {
      snapshot[prop] = this[prop];
    }

    return snapshot;
  }

  set version(version: number) {
    this[VERSION] = version;
  }

  get version(): number {
    return this[VERSION];
  }

  applyEvent<T extends EventBase = EventBase>(event: T, fromHistory = false) {
    this[VERSION]++;

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

  loadFromSnapshot(snapshot: ISnapshot<Aggregate>) {
    for (const prop in snapshot) {
      if (prop === 'version') {
        this[VERSION] = snapshot[prop];
        continue;
      }
      this[prop] = snapshot[prop];
    }
  }

  loadFromHistory(events: EventBase[]) {
    events.forEach((event) => this.applyEvent(event, true));
  }
}
