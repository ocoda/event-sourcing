import { instanceToPlain, plainToInstance } from 'class-transformer';
import { Injectable, Type } from '@nestjs/common';
import { IEvent, IEventSerializer } from '../interfaces';

@Injectable()
export class DefaultEventSerializer implements IEventSerializer {
  serialize(event: IEvent): Record<string, any> {
    return instanceToPlain(event);
  }

  deserialize<T extends IEvent>(payload: Record<string, any>, cls: Type<T>): T {
    return plainToInstance<T, Record<string, any>>(cls, payload);
  }
}
