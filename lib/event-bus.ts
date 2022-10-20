import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { from, Observable, Subscription } from 'rxjs';
import { filter, mergeMap } from 'rxjs/operators';
import { ObservableBus } from './helpers';
import { DefaultEventPubSub } from './helpers/default-event-publisher';
import { IEventBus, IEventHandler, IEventPublisher } from './interfaces';
import { EventEnvelope } from './models';

@Injectable()
export class EventBus extends ObservableBus<EventEnvelope> implements IEventBus, OnModuleDestroy {
	protected readonly subscriptions: Subscription[] = [];
	private publishers: IEventPublisher[] = [new DefaultEventPubSub(this.subject$)];

	onModuleDestroy() {
		this.subscriptions.forEach((subscription) => subscription.unsubscribe());
	}

	publish = (envelope: EventEnvelope) => this.publishers.forEach((publisher) => publisher.publish(envelope));

	bind(handler: IEventHandler, name: string) {
		const stream$ = name ? this.ofEventName(name) : this.subject$;
		const subscription = stream$
			.pipe(mergeMap((envelope) => from(Promise.resolve(handler.handle(envelope)))))
			.subscribe({
				error: (error) => {
					throw error;
				},
			});
		this.subscriptions.push(subscription);
	}

	addPublisher(publisher: IEventPublisher) {
		this.publishers.push(publisher);
	}

	protected ofEventName(eventName: string): Observable<EventEnvelope> {
		return this.subject$.pipe(filter(({ event }) => event === eventName));
	}
}
