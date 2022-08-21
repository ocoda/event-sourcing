import { Type } from '@nestjs/common';
import { IEvent, IEventSerializer } from './events';

export interface EventSourcingModuleOptions {
  events: [Type<IEvent>, IEventSerializer?][];
}
