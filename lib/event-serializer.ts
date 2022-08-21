import { Type } from '@nestjs/common';
import { IEvent, IEventSerializer } from './interfaces';

export abstract class EventSerializer<EventBase extends IEvent = IEvent>
  implements IEventSerializer
{
  abstract serialize(event: EventBase): Record<string, any>;
  abstract deserialize(
    payload: Record<string, any>,
    cls: Type<EventBase>,
  ): EventBase;
}
