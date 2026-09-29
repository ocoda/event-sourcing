import {
	type BeforeApplicationShutdown,
	Injectable,
	Logger,
	type OnApplicationShutdown,
	Optional,
	type Type,
} from '@nestjs/common';
import { EMPTY, type Observable, Subject, type Subscription, defer } from 'rxjs';
import { catchError, filter, finalize, mergeMap } from 'rxjs/operators';

import { InjectEventSourcingOptions } from './decorators/index.js';
import { MissingEventMetadataException, MissingEventSubscriberMetadataException } from './exceptions/index.js';
import { DefaultEventPubSub } from './helpers/default-event-publisher.js';
import { ObservableBus, getEventMetadata, getEventSubscriberMetadata } from './helpers/index.js';
import type {
	EnvelopePublisher,
	EventDeliveryError,
	EventSourcingModuleOptions,
	IEventBus,
	IEventPublisher,
	IEventSubscriber,
	ProviderWrapper,
} from './interfaces/index.js';
import type { EventEnvelope } from './models/index.js';

const logger = new Logger('EventBus');

/**
 * How long one call of a publisher may take by default, in milliseconds.
 */
const DEFAULT_PUBLISHER_TIMEOUT = 30_000;
/**
 * How long the application's shutdown waits for the bus to become idle by default, in milliseconds.
 */
const DEFAULT_SHUTDOWN_TIMEOUT = 10_000;
/**
 * `setTimeout` fires after 1 ms for a delay above 2^31 - 1 ms (about 24.8 days), so a longer timeout means none.
 */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

const describeError = (error: unknown): string =>
	error instanceof Error ? error.stack || error.message : String(error);

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
	typeof (value as PromiseLike<unknown> | undefined)?.then === 'function';

const nameOf = (handler: unknown): string =>
	(handler as { constructor?: { name?: string } } | undefined)?.constructor?.name || 'unknown';

/**
 * A timeout option in milliseconds, where 0 disables the timeout. Omitted, it is the fallback; anything but a
 * non-negative number throws a `RangeError`, like the batch size of `readAll`.
 */
const toTimeout = (value: unknown, fallback: number, option: string): number => {
	if (value === undefined || value === null) {
		return fallback;
	}
	if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
		throw new RangeError(
			`Not a timeout for ${option}: ${String(value)}. Expected a number of milliseconds, or 0 to disable it.`,
		);
	}
	return value > MAX_TIMER_DELAY ? 0 : value;
};

/**
 * A timeout, as the web platform reports it (`AbortSignal.timeout()`): a `DOMException` named `TimeoutError`.
 */
const timeoutError = (message: string): DOMException => new DOMException(message, 'TimeoutError');

type Settled = { readonly failed: false } | { readonly failed: true; readonly error: unknown };

const DELIVERED: Settled = { failed: false };

/**
 * Calls a publisher. A call that returns no promise settles synchronously, so synchronous publishers (the default
 * one, which feeds the subscribers) get the envelopes of an append without waiting for the event loop. A promise is
 * awaited until it settles or the timeout (0: none) elapses; a promise that settles after its timeout is still
 * handled, so it can't become an unhandled rejection.
 */
const settle = (call: () => unknown, timeout: number, describe: () => string): Settled | Promise<Settled> => {
	let result: unknown;
	try {
		result = call();
	} catch (error) {
		return { failed: true, error };
	}
	if (!isPromiseLike(result)) {
		return DELIVERED;
	}

	const settled = Promise.resolve(result).then(
		(): Settled => DELIVERED,
		(error: unknown): Settled => ({ failed: true, error }),
	);
	if (timeout === 0) {
		return settled;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<Settled>((resolve) => {
		timer = setTimeout(
			() => resolve({ failed: true, error: timeoutError(`${describe()} took longer than ${timeout} ms`) }),
			timeout,
		);
	});
	return Promise.race([settled, timedOut]).finally(() => clearTimeout(timer));
};

/**
 * Publishes the envelopes of every append to the event publishers, and through the default publisher to the event
 * subscribers (ADR 0001 §2).
 *
 * - **Publishers** get an append's envelopes in commit order: one `publish` call per envelope, each awaited before
 *   the next, or one `publishAll` call if they implement it. The publishers run concurrently, and every call races
 *   `publishing.publisherTimeout` (30 s by default, `0` disables it). A publisher that throws, rejects or times out
 *   is logged and reported on {@link EventBus.deliveryErrors$}; it still gets the later envelopes, and the other
 *   publishers aren't affected. {@link EventBus.publishAll} resolves once every publisher settled, and never rejects.
 * - **Order.** Each publisher gets the appends one after the other, in the order in which they were published: while
 *   it still handles an append, the next append waits for it (for that publisher only), even when the appends run
 *   concurrently. A publisher with nothing to catch up on is called at once, so a synchronous one (like the default
 *   one, which feeds the subscribers) gets the envelopes synchronously.
 * - **Subscribers** handle the envelopes in parallel and are not awaited. A failing subscriber is logged and reported
 *   on {@link EventBus.deliveryErrors$}, and keeps receiving later envelopes.
 * - **Shutdown.** `beforeApplicationShutdown` waits for the running publishers and subscribers
 *   ({@link EventBus.whenIdle}), for at most `publishing.shutdownTimeout` (10 s by default), and
 *   `onApplicationShutdown` unsubscribes the subscribers.
 *
 * Delivery is in-process, at-most-once and ordered per publisher.
 */
@Injectable()
export class EventBus
	extends ObservableBus<EventEnvelope>
	implements IEventBus, EnvelopePublisher, BeforeApplicationShutdown, OnApplicationShutdown
{
	protected readonly subscriptions: Subscription[] = [];
	private publishers: IEventPublisher[] = [new DefaultEventPubSub(this.subject$)];
	private readonly deliveryErrorsSubject = new Subject<EventDeliveryError>();
	/**
	 * Every failure of a publisher (including a timeout) or a subscriber, one per envelope. They are logged as well.
	 */
	readonly deliveryErrors$: Observable<EventDeliveryError> = this.deliveryErrorsSubject.asObservable();

	private readonly publisherTimeout: number;
	private readonly shutdownTimeout: number;
	private pendingPublications = 0;
	private pendingHandlers = 0;
	private readonly idleWaiters = new Set<() => void>();
	/**
	 * The last delivery of each publisher that is still handling an append; the next append's delivery to it waits for
	 * it. A publisher is only in here while a delivery to it is asynchronous.
	 */
	private readonly deliveries = new Map<IEventPublisher, Promise<void>>();

	/**
	 * @throws RangeError when a timeout of the `publishing` options is not a non-negative number
	 */
	constructor(@Optional() @InjectEventSourcingOptions() options?: Pick<EventSourcingModuleOptions, 'publishing'>) {
		super();
		const publishing = options?.publishing;
		this.publisherTimeout = toTimeout(
			publishing?.publisherTimeout,
			DEFAULT_PUBLISHER_TIMEOUT,
			'publishing.publisherTimeout',
		);
		this.shutdownTimeout = toTimeout(
			publishing?.shutdownTimeout,
			DEFAULT_SHUTDOWN_TIMEOUT,
			'publishing.shutdownTimeout',
		);
	}

	/**
	 * Waits for the running publishers and subscribers before the application shuts down, so that the stores are not
	 * disconnected under them. Gives up after `publishing.shutdownTimeout`, with a warning.
	 */
	async beforeApplicationShutdown(): Promise<void> {
		try {
			await this.whenIdle({ timeout: this.shutdownTimeout });
		} catch (error) {
			logger.warn(`${error instanceof Error ? error.message : String(error)}; shutting down anyway`);
		}
	}

	/**
	 * Unsubscribes the subscribers, once the application has shut down.
	 */
	onApplicationShutdown(): void {
		for (const subscription of this.subscriptions.splice(0)) {
			subscription.unsubscribe();
		}
	}

	/**
	 * Publishes one envelope, like {@link EventBus.publishAll} does for the envelopes of an append. Never rejects.
	 */
	publish = (envelope: EventEnvelope): Promise<void> => this.publishAll([envelope]);

	/**
	 * Publishes the envelopes of one append, in order, to every publisher, and resolves once every publisher has
	 * settled or timed out. Never rejects: a failure is logged and reported on {@link EventBus.deliveryErrors$}.
	 */
	async publishAll(envelopes: readonly EventEnvelope[]): Promise<void> {
		let batch: readonly EventEnvelope[];
		try {
			batch = Object.freeze([...(envelopes ?? [])]);
		} catch (error) {
			// Not iterable: nothing to publish, and publishing never makes an append fail
			logger.error('Failed to publish the envelopes of an append', describeError(error));
			return;
		}
		if (batch.length === 0) {
			return;
		}

		this.pendingPublications++;
		try {
			await Promise.allSettled(this.publishers.map((publisher) => this.enqueue(publisher, batch)));
		} finally {
			this.pendingPublications--;
			this.notifyIfIdle();
		}
	}

	/**
	 * Resolves once no publisher or subscriber is running, which is at once when none is. Use it in tests instead of
	 * waiting for a fixed time, and before `app.close()` when your subscribers use providers that
	 * `onModuleDestroy` tears down. Don't await it inside a publisher or a subscriber: it would wait for itself.
	 *
	 * @param options.timeout how long to wait at most, in milliseconds; omitted or `0`, it waits as long as it takes
	 * @throws DOMException named `TimeoutError` when the bus is still busy after the timeout
	 * @throws RangeError when the timeout is not a non-negative number
	 */
	whenIdle(options?: { timeout?: number }): Promise<void> {
		let timeout: number;
		try {
			timeout = toTimeout(options?.timeout, 0, 'whenIdle');
		} catch (error) {
			return Promise.reject(error);
		}
		if (this.isIdle()) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const waiter = () => {
				clearTimeout(timer);
				resolve();
			};
			this.idleWaiters.add(waiter);
			if (timeout > 0) {
				timer = setTimeout(() => {
					this.idleWaiters.delete(waiter);
					reject(
						timeoutError(
							`The event bus is not idle after ${timeout} ms: ${this.pendingPublications} publication(s) and ${this.pendingHandlers} subscriber call(s) are still running`,
						),
					);
				}, timeout);
			}
		});
	}

	/**
	 * Bind a subscriber to the stream of envelopes (optionally filtered by event name).
	 * Every invocation of the subscriber is isolated: a synchronous throw or a rejected promise is logged, reported on
	 * {@link EventBus.deliveryErrors$}, and the subscription stays active for subsequent envelopes.
	 */
	bind(handler: IEventSubscriber, name: string) {
		const stream$ = name ? this.ofEventName(name) : this.subject$;
		const subscription = stream$
			.pipe(
				mergeMap((envelope) =>
					defer(() => {
						this.pendingHandlers++;
						return Promise.resolve(handler.handle(envelope));
					}).pipe(
						catchError((error) => {
							const subscriber = nameOf(handler);
							logger.error(
								`Event subscriber ${subscriber} failed to handle event "${envelope?.event}"`,
								describeError(error),
							);
							this.deliveryErrorsSubject.next({ kind: 'subscriber', handler: subscriber, envelope, error });
							return EMPTY;
						}),
						finalize(() => {
							this.pendingHandlers--;
							this.notifyIfIdle();
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

	/**
	 * Delivers the envelopes of an append to one publisher once its delivery of the earlier appends settled, so that it
	 * gets the appends in the order in which they were published. Never rejects.
	 *
	 * @returns the delivery, or nothing when it finished synchronously
	 */
	private enqueue(publisher: IEventPublisher, envelopes: readonly EventEnvelope[]): Promise<void> | undefined {
		const previous = this.deliveries.get(publisher);
		const run = () => this.deliver(publisher, envelopes);
		const delivery = previous ? previous.then(run, run) : run();
		if (delivery) {
			this.deliveries.set(publisher, delivery);
			const release = () => {
				if (this.deliveries.get(publisher) === delivery) {
					this.deliveries.delete(publisher);
				}
			};
			delivery.then(release, release);
		}
		return delivery;
	}

	/**
	 * Delivers the envelopes of an append to one publisher: one `publishAll` call, or one `publish` call per envelope,
	 * in order, each awaited before the next. Never rejects.
	 *
	 * @returns the rest of the delivery, or nothing when the publisher took every envelope synchronously
	 */
	private deliver(publisher: IEventPublisher, envelopes: readonly EventEnvelope[]): Promise<void> | undefined {
		const handler = nameOf(publisher);
		if (typeof publisher.publishAll !== 'function') {
			return this.deliverEach(publisher, handler, envelopes, 0);
		}

		const outcome = settle(
			() => publisher.publishAll?.(envelopes),
			this.publisherTimeout,
			() => `Publishing ${envelopes.length} event(s) with ${handler}`,
		);
		const report = (settled: Settled) =>
			this.reportPublisherFailure(handler, envelopes, settled, `${envelopes.length} event(s)`);
		if (isPromiseLike(outcome)) {
			return outcome.then(report);
		}
		report(outcome);
		return undefined;
	}

	/**
	 * Calls `publish` for the envelopes from `start` on, one after the other: synchronously as long as the publisher
	 * returns no promise, and from its first promise on, each call once the previous one settled.
	 */
	private deliverEach(
		publisher: IEventPublisher,
		handler: string,
		envelopes: readonly EventEnvelope[],
		start: number,
	): Promise<void> | undefined {
		for (let index = start; index < envelopes.length; index++) {
			const envelope = envelopes[index] as EventEnvelope;
			const outcome = settle(
				() => publisher.publish(envelope),
				this.publisherTimeout,
				() => `Publishing event "${envelope?.event}" with ${handler}`,
			);
			const report = (settled: Settled) =>
				this.reportPublisherFailure(handler, [envelope], settled, `event "${envelope?.event}"`);
			if (isPromiseLike(outcome)) {
				return outcome.then((settled) => {
					report(settled);
					return this.deliverEach(publisher, handler, envelopes, index + 1);
				});
			}
			report(outcome);
		}
		return undefined;
	}

	/**
	 * Logs a failed call of a publisher once, and reports it on {@link EventBus.deliveryErrors$} for each of its envelopes.
	 */
	private reportPublisherFailure(
		handler: string,
		envelopes: readonly EventEnvelope[],
		outcome: Settled,
		what: string,
	): void {
		if (!outcome.failed) {
			return;
		}
		logger.error(`Event publisher ${handler} failed to publish ${what}`, describeError(outcome.error));
		for (const envelope of envelopes) {
			this.deliveryErrorsSubject.next({ kind: 'publisher', handler, envelope, error: outcome.error });
		}
	}

	private isIdle(): boolean {
		return this.pendingPublications === 0 && this.pendingHandlers === 0;
	}

	private notifyIfIdle(): void {
		if (!this.isIdle()) {
			return;
		}
		for (const waiter of this.idleWaiters) {
			waiter();
		}
		this.idleWaiters.clear();
	}
}
