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
	private _publisher: IEventPublisher = new DefaultEventPubSub(this.subject$);

	get publisher(): IEventPublisher {
		return this._publisher;
	}

	set publisher(_publisher: IEventPublisher) {
		this._publisher = _publisher;
	}

	onModuleDestroy() {
		this.subscriptions.forEach((subscription) => subscription.unsubscribe());
	}

	publish = (envelope: EventEnvelope) => this._publisher.publish(envelope, this.subject$);

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

	protected ofEventName(eventName: string): Observable<EventEnvelope> {
		return this.subject$.pipe(filter(({ event }) => event === eventName));
	}
}
