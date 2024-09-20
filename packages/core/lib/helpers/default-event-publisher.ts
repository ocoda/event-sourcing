import type { Subject } from 'rxjs';
import type { IEventPublisher } from '../interfaces';
import type { EventEnvelope } from '../models';

export class DefaultEventPubSub implements IEventPublisher {
	constructor(private subject$: Subject<EventEnvelope>) {}

	publish(envelope: EventEnvelope) {
		this.subject$.next(envelope);
	}
}
