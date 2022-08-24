import { Type } from '@nestjs/common';
import { IEvent, ISnapshot } from '../interfaces';

const EVENTS = Symbol();
const USE_SNAPSHOTS = Symbol();

export abstract class Aggregate<
  EventBase extends IEvent = IEvent,
  SnapshotBase extends ISnapshot = ISnapshot,
> {
  private _version: number = 0;
  private readonly [USE_SNAPSHOTS] = false;
  private readonly [EVENTS]: EventBase[] = [];

  set version(version: number) {
    this._version = version;
  }

  get version(): number {
    return this._version;
  }

  createSnapshot?(): SnapshotBase;
  loadSnapshot?(snapshot: SnapshotBase): void;

  apply<T extends EventBase = EventBase>(event: T) {
    this._version++;

    this[EVENTS].push(event);

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

  commit(): IEvent[] {
    const events = [...this[EVENTS]];
    this[EVENTS].length = 0;

    return events;
  }

  loadFromHistory(events: EventBase[], snapshot?: SnapshotBase) {
    if (this[USE_SNAPSHOTS] && snapshot) {
      this.loadSnapshot(snapshot);
    }
    events.forEach((event) => this.apply(event));
  }
}
