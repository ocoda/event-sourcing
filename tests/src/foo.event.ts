import { IEvent } from '@ocoda/event-sourcing';

export class FooEvent implements IEvent {
  constructor(public location: string, public registration: Date) {}
}
