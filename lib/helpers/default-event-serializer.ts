import { instanceToPlain, plainToInstance } from 'class-transformer';
import { Type } from '@nestjs/common';
import { EventSerializer } from '../event-serializer';
import { IEvent, IEventSerializer } from '../interfaces';

export class DefaultEventSerializer
  extends EventSerializer
  implements IEventSerializer
{
  serialize(event: IEvent): Record<string, any> {
    return instanceToPlain(event);
  }

  deserialize<T extends IEvent>(payload: Record<string, any>, cls: Type<T>): T {
    return plainToInstance<T, Record<string, any>>(cls, payload);
  }
}
