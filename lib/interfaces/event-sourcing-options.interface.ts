import { Type } from '@nestjs/common';
import { IEvent, IEventSerializer } from './events';

export interface EventSourcingModuleOptions {
  eventMap: [Type<IEvent>, IEventSerializer][];
}
