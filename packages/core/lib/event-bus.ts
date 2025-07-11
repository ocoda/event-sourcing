import { Injectable, type OnModuleDestroy, type Type } from '@nestjs/common';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { type Observable, type Subscription, from } from 'rxjs';
import { filter, mergeMap } from 'rxjs/operators';

import { MissingEventMetadataException, MissingEventSubscriberMetadataException } from './exceptions';
import { ObservableBus, getEventMetadata, getEventSubscriberMetadata } from './helpers';
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

	// region registration
	registerPublishers(publishers: InstanceWrapper<IEventPublisher>[] = []) {
		for (const publisher of publishers) {
			this.registerPublisher(publisher);
		}
	}
	registerSubscribers(subscribers: InstanceWrapper<IEventSubscriber>[] = []) {
		for (const subscriber of subscribers) {
			this.registerSubscriber(subscriber);
		}
	}

	protected registerPublisher(handler: InstanceWrapper<IEventPublisher>) {
		const { instance } = handler;
		if (!instance) return;

		this.addPublisher(instance as IEventPublisher);
	}
	protected registerSubscriber(handler: InstanceWrapper<IEventSubscriber>) {
		const { metatype, instance } = handler;
		if (!metatype || !instance) {
			throw new MissingEventSubscriberMetadataException(metatype as Type<IEventSubscriber>);
		}

		// check if the handler is an event subscriber
		const { events } = getEventSubscriberMetadata(metatype as Type<IEventSubscriber>);

		// if not, throw an error
		if (!events) {
			throw new MissingEventSubscriberMetadataException(metatype);
		}

		// register the subscriber for each event
		for (const event of events) {
			const { name } = getEventMetadata(event);
			if (!name) {
				throw new MissingEventMetadataException(event);
			}
			this.bind(instance as IEventSubscriber, name);
		}
	}
	// endregion
}
