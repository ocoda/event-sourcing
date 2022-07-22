import { EventListener } from '@ocoda/event-sourcing';
import { FooEvent } from './foo.event';

export class FooEventHandler {
  constructor(public spy?: (event: FooEvent) => void) {}

  @EventListener(FooEvent)
  onFooCreated(event: FooEvent) {
    this.spy && this.spy(event);
  }
}
