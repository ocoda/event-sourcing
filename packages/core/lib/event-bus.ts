import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type Observable, type Subscription, from } from 'rxjs';
import { filter, mergeMap } from 'rxjs/operators';
import { ObservableBus } from './helpers';
import { DefaultEventPubSub } from './helpers/default-event-publisher';
import type { IEventBus, IEventPublisher, IEventSubscriber } from './interfaces';
import type { EventEnvelope } from './models';

@Injectable()
export class EventBus extends ObservableBus<EventEnvelope> implements IEventBus, OnModuleDestroy {
	protected readonly subscriptions: Subscription[] = [];
	private publishers: IEventPublisher[] = [new DefaultEventPubSub(this.subject$)];

	onModuleDestroy() {
		for (const subscription of this.subscriptions) {
			subscription.unsubscribe();
		}
	}

	publish = (envelope: EventEnvelope) => {
		for (const publisher of this.publishers) {
			publisher.publish(envelope);
		}
	};

	bind(handler: IEventSubscriber, name: string) {
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
