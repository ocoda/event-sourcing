import { EventName, IEvent, IEventSerializer } from '@ocoda/event-sourcing';

export const FooEventSerializer: IEventSerializer<
  FooEvent,
  { location: string; registration: string }
> = {
  serialize: ({ location, registration }) => ({
    location,
    registration: registration.toISOString(),
  }),
  deserialize: ({ location, registration }) =>
    new FooEvent(location, new Date(registration)),
};

@EventName('foo-event')
export class FooEvent implements IEvent {
  constructor(public location: string, public registration: Date) {}
}
