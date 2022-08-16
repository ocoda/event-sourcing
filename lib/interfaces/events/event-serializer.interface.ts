import { Type } from '@nestjs/common';
import { IEvent } from './event.interface';

export type EventSerializerType = Type<IEventSerializer<IEvent>>;

export interface IEventSerializer<
  BaseEvent extends IEvent = IEvent,
  Payload extends Record<string, unknown> = Record<string, unknown>,
> {
  serialize: (event: BaseEvent) => Payload;
  deserialize: (payload: Payload) => BaseEvent;
}
