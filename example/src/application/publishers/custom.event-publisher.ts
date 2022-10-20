import { EventPublisher, IEventPublisher } from '@ocoda/event-sourcing';

@EventPublisher()
export class CustomEventPublisher implements IEventPublisher {
	async publish(): Promise<void> {}
}
