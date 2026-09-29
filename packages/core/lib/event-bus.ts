import { Injectable, Logger, type OnModuleDestroy, type Type } from '@nestjs/common';
import { EMPTY, type Observable, type Subscription, defer } from 'rxjs';
import { catchError, filter, mergeMap } from 'rxjs/operators';

import { MissingEventMetadataException, MissingEventSubscriberMetadataException } from './exceptions/index.js';
import { DefaultEventPubSub } from './helpers/default-event-publisher.js';
import { ObservableBus, getEventMetadata, getEventSubscriberMetadata } from './helpers/index.js';
import type {
	EnvelopePublisher,
	IEventBus,
	IEventPublisher,
	IEventSubscriber,
	ProviderWrapper,
} from './interfaces/index.js';
import type { EventEnvelope } from './models/index.js';

const logger = new Logger('EventBus');

const describeError = (error: unknown): string =>
	error instanceof Error ? error.stack || error.message : String(error);

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
	typeof (value as PromiseLike<unknown> | undefined)?.then === 'function';

const logPublisherError = (publisher: IEventPublisher, envelope: EventEnvelope, error: unknown) =>
	logger.error(
		`Event publisher ${publisher?.constructor?.name ?? 'unknown'} failed to publish event "${envelope?.event}"`,
		describeError(error),
	);

const logSubscriberError = (subscriber: IEventSubscriber, envelope: EventEnvelope, error: unknown) =>
	logger.error(
		`Event subscriber ${subscriber?.constructor?.name ?? 'unknown'} failed to handle event "${envelope?.event}"`,
		describeError(error),
	);

@Injectable()
export class EventBus extends ObservableBus<EventEnvelope> implements IEventBus, EnvelopePublisher, OnModuleDestroy {
	protected readonly subscriptions: Subscription[] = [];
	private publishers: IEventPublisher[] = [new DefaultEventPubSub(this.subject$)];

	onModuleDestroy() {
		for (const subscription of this.subscriptions) {
			subscription.unsubscribe();
		}
	}

	/**
	 * Publish an envelope to every registered publisher.
	 * Publishers are isolated from each other: a publisher that throws or returns a rejected promise is logged and
	 * does not prevent the remaining publishers from receiving the envelope, nor does it propagate to the caller.
	 */
	publish = (envelope: EventEnvelope) => {
		for (const publisher of this.publishers) {
			try {
				const result = publisher.publish(envelope);
				if (isPromiseLike(result)) {
					Promise.resolve(result).catch((error) => logPublisherError(publisher, envelope, error));
				}
			} catch (error) {
				logPublisherError(publisher, envelope, error);
			}
		}
	};

	/**
	 * Publish the envelopes of one append, in order, to every registered publisher. Never rejects: like
	 * {@link EventBus.publish}, a failing publisher is logged and doesn't stop the other publishers or envelopes.
	 * Asynchronous publishers are not awaited.
	 */
	async publishAll(envelopes: readonly EventEnvelope[]): Promise<void> {
		try {
			for (const envelope of envelopes ?? []) {
				try {
					this.publish(envelope);
				} catch (error) {
					logger.error(`Failed to publish event "${envelope?.event}"`, describeError(error));
				}
			}
		} catch (error) {
			// Not iterable: nothing to publish, and publishing never makes an append fail
			logger.error('Failed to publish the envelopes of an append', describeError(error));
		}
	}

	/**
	 * Bind a subscriber to the stream of envelopes (optionally filtered by event name).
	 * Every invocation of the subscriber is isolated: a synchronous throw or a rejected promise is logged and the
	 * subscription stays active for subsequent envelopes.
	 */
	bind(handler: IEventSubscriber, name: string) {
		const stream$ = name ? this.ofEventName(name) : this.subject$;
		const subscription = stream$
			.pipe(
				mergeMap((envelope) =>
					defer(() => Promise.resolve(handler.handle(envelope))).pipe(
						catchError((error) => {
							logSubscriberError(handler, envelope, error);
							return EMPTY;
						}),
					),
				),
			)
			.subscribe();
		this.subscriptions.push(subscription);
	}

	addPublisher(publisher: IEventPublisher) {
		this.publishers.push(publisher);
	}

	protected ofEventName(eventName: string): Observable<EventEnvelope> {
		return this.subject$.pipe(filter(({ event }) => event === eventName));
	}

	registerPublishers(publishers: ProviderWrapper<IEventPublisher>[] = []) {
		for (const publisher of publishers) {
			this.registerPublisher(publisher);
		}
	}
	registerSubscribers(subscribers: ProviderWrapper<IEventSubscriber>[] = []) {
		for (const subscriber of subscribers) {
			this.registerSubscriber(subscriber);
		}
	}

	protected registerPublisher(handler: ProviderWrapper<IEventPublisher>) {
		const { instance } = handler;
		if (!instance) return;

		this.addPublisher(instance as IEventPublisher);
	}
	protected registerSubscriber(handler: ProviderWrapper<IEventSubscriber>) {
		const { metatype, instance } = handler;
		if (!metatype || !instance) {
			throw new MissingEventSubscriberMetadataException({ subscriber: metatype as Type<IEventSubscriber> });
		}

		// check if the handler is an event subscriber
		const { events } = getEventSubscriberMetadata(metatype as Type<IEventSubscriber>);

		// if not, throw an error
		if (!events) {
			throw new MissingEventSubscriberMetadataException({ subscriber: metatype });
		}

		// register the subscriber for each event
		for (const event of events) {
			const { name } = getEventMetadata(event);
			if (!name) {
				throw new MissingEventMetadataException({ event });
			}
			this.bind(instance as IEventSubscriber, name);
		}
	}
}
