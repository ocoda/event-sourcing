import type { Subject } from 'rxjs';
import type { IEventPublisher } from '../interfaces/index.js';
import type { EventEnvelope } from '../models/index.js';

export class DefaultEventPubSub implements IEventPublisher {
	constructor(private subject$: Subject<EventEnvelope>) {}

	publish(envelope: EventEnvelope) {
		this.subject$.next(envelope);
	}
}
