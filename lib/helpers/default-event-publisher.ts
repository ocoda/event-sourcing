import { Subject } from 'rxjs';
import { IEventPublisher } from '../interfaces';
import { EventEnvelope } from '../models';

export class DefaultEventPubSub implements IEventPublisher {
	constructor(private subject$: Subject<EventEnvelope>) {}

	publish(envelope: EventEnvelope) {
		this.subject$.next(envelope);
	}
}
