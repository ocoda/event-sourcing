import { Subject } from 'rxjs';
import { IEvent, IEventPublisher } from '../interfaces';

export class DefaultEventPubSub<EventBase extends IEvent = IEvent> implements IEventPublisher<EventBase> {
	constructor(private subject$: Subject<EventBase>) {}

	publish<T extends EventBase>(event: T) {
		this.subject$.next(event);
	}
}
