import { Type } from '@nestjs/common';
import 'reflect-metadata';
import { IEvent } from './interfaces';

export type EventType = Type<IEvent>;
// export type EventListenerType = Type<IEventListener<IEvent>>;
