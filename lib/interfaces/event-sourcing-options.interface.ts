import { Type } from '@nestjs/common';
import { IEvent } from './events';

export interface EventSourcingModuleOptions {
  events: Type<IEvent>[];
  disableDefaultSerializer?: boolean;
}
