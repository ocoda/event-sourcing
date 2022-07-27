import { IEvent } from './event.interface';

export interface IEventSerializer<BaseEvent extends IEvent = IEvent> {
  serialize: (event: BaseEvent) => Record<string, unknown>;
  deserialize: (payload: Record<string, unknown>) => IEvent;
}
