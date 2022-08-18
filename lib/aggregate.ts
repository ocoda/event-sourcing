import { Type } from '@nestjs/common';
import { IEvent, ISnapshot } from './interfaces';

const USE_SNAPSHOTS = Symbol();

export abstract class Aggregate<
  EventBase extends IEvent = IEvent,
  SnapshotBase extends ISnapshot = ISnapshot,
> {
  private readonly [USE_SNAPSHOTS] = true;

  createSnapshot?(): SnapshotBase;
  loadSnapshot?(snapshot: SnapshotBase): void;

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

  protected getEventName(event: EventBase): string {
    const { constructor } = Object.getPrototypeOf(event);
    return constructor.name;
  }

  loadFromHistory(events: EventBase[], snapshot?: SnapshotBase) {
    this[USE_SNAPSHOTS] && this.loadSnapshot(snapshot);
    events.forEach((event) => this.apply(event));
  }
}
