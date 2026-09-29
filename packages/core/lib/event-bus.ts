import { AsyncLocalStorage } from 'node:async_hooks';

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

/**
 * A value as text, also for one that has no string form (`Object.create(null)`), so that reporting a failure can't fail.
 */
const show = (value: unknown): string => {
	try {
		return String(value);
	} catch {
		return Object.prototype.toString.call(value);
	}
};

const describeError = (error: unknown): string => {
	try {
		if (error instanceof Error) {
			return error.stack || error.message;
		}
	} catch {
		// A throwing getter: fall through to the plain description
	}
	return show(error);
};

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
			`Not a timeout for ${option}: ${show(value)}. Expected a number of milliseconds, or 0 to disable it.`,
		);
	}
	return value > MAX_TIMER_DELAY ? 0 : value;
};

/**
 * A timeout, as the web platform reports it (`AbortSignal.timeout()`): a `DOMException` named `TimeoutError`.
 */
const timeoutError = (message: string): DOMException => new DOMException(message, 'TimeoutError');

/**
 * The publishers whose call is running in the current async context. When a publisher appends or publishes from inside
 * its own call, it gets those envelopes at once: queued behind the call that waits for them, they would wait for
 * themselves until the timeout, or forever without one.
 */
const delivering = new AsyncLocalStorage<ReadonlySet<IEventPublisher>>();
const NO_PUBLISHERS: ReadonlySet<IEventPublisher> = new Set();

/**
 * Runs a call of a publisher in the async context of its delivery, which is also that of the calls it runs in.
 */
const within = (publisher: IEventPublisher, call: () => unknown): unknown => {
	const publishers = new Set(delivering.getStore());
	publishers.add(publisher);
	return delivering.run(publishers, call);
};

/**
 * The stream an envelope belongs to, which the deliveries to a publisher are ordered by: its aggregate id.
 */
const streamOf = (envelope: EventEnvelope | undefined): unknown => envelope?.metadata?.aggregateId;

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
 * - **Order.** Each publisher gets the appends of a stream one after the other, in the order in which they were
 *   published: while it still handles an append, the next append to the same stream waits for it (for that publisher
 *   only), even when the appends run concurrently. Appends to other streams don't wait for it, so a slow publisher
 *   holds back one stream, not every aggregate; the order across streams is that of `readAll`. A publisher with
 *   nothing to catch up on is called at once, so a synchronous one gets the envelopes synchronously. The default
 *   publisher, which feeds the subscribers, gets them last, so what a subscriber appends to the stream in reaction
 *   reaches the other publishers after the event that caused it. A publisher that appends or publishes from inside its
 *   own call gets those envelopes at once, instead of after the call that waits for them.
 * - **Subscribers** handle the envelopes in parallel and are not awaited. A failing subscriber is logged and reported
 *   on {@link EventBus.deliveryErrors$}, and keeps receiving later envelopes.
 * - **Shutdown.** `beforeApplicationShutdown` waits for the running publishers and subscribers
 *   ({@link EventBus.whenIdle}), for at most `publishing.shutdownTimeout` (10 s by default), and
 *   `onApplicationShutdown` unsubscribes the subscribers.
 *
 * Delivery is in-process, at-most-once and ordered per publisher and stream.
 */
@Injectable()
export class EventBus
	extends ObservableBus<EventEnvelope>
	implements IEventBus, EnvelopePublisher, BeforeApplicationShutdown, OnApplicationShutdown
{
	protected readonly subscriptions: Subscription[] = [];
	/**
	 * The default publisher, which feeds the subscribers. It gets every append after the other publishers.
	 */
	private readonly subscriberFeed: IEventPublisher = new DefaultEventPubSub(this.subject$);
	private readonly publishers: IEventPublisher[] = [];
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
	 * Per publisher, the last delivery of each stream that it is still handling; the next delivery of that stream to it
	 * waits for it. A stream is only in here while a delivery of it is asynchronous.
	 */
	private readonly deliveries = new Map<IEventPublisher, Map<unknown, Promise<void>>>();

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
			const deliveries = this.publishers.map((publisher) => this.enqueue(publisher, batch));
			// Last: what a subscriber appends in reaction then reaches the publishers after the event that caused it
			deliveries.push(this.enqueue(this.subscriberFeed, batch));
			await Promise.allSettled(deliveries);
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
	 * Delivers the envelopes of an append to one publisher once its delivery of the earlier appends to the same stream
	 * settled, so that it gets the appends of a stream in the order in which they were published. Appends to other
	 * streams don't wait. Never rejects.
	 *
	 * @returns the delivery, or nothing when it finished synchronously
	 */
	private enqueue(publisher: IEventPublisher, envelopes: readonly EventEnvelope[]): Promise<void> | undefined {
		if (delivering.getStore()?.has(publisher)) {
			// The publisher appends or publishes from inside its own call: queued behind that call, it would wait for itself
			return this.deliver(publisher, envelopes);
		}

		// An append has one stream; a batch someone publishes directly may have several, and waits for each of them
		const streams = new Set(envelopes.map(streamOf));
		const previous: Promise<void>[] = [];
		for (const stream of streams) {
			const running = this.deliveries.get(publisher)?.get(stream);
			if (running) {
				previous.push(running);
			}
		}
		const run = () => this.deliver(publisher, envelopes);
		const delivery = previous.length > 0 ? Promise.all(previous).then(run, run) : run();
		if (!delivery) {
			return undefined;
		}

		// Looked up after the call, which may have queued another delivery to this publisher
		const queue = this.deliveries.get(publisher) ?? new Map<unknown, Promise<void>>();
		this.deliveries.set(publisher, queue);
		for (const stream of streams) {
			queue.set(stream, delivery);
		}
		const release = () => {
			for (const stream of streams) {
				if (queue.get(stream) === delivery) {
					queue.delete(stream);
				}
			}
			if (queue.size === 0 && this.deliveries.get(publisher) === queue) {
				this.deliveries.delete(publisher);
			}
		};
		delivery.then(release, release);
		return delivery;
	}

	/**
	 * Calls a publisher in the async context of its delivery, so that what it appends or publishes from inside the call
	 * doesn't wait for the call (see `delivering`). The subscriber feed runs outside of every delivery: no call waits for
	 * the subscribers, so what they append queues like any other append.
	 */
	private invoke(publisher: IEventPublisher, call: () => unknown): () => unknown {
		return () => (publisher === this.subscriberFeed ? delivering.run(NO_PUBLISHERS, call) : within(publisher, call));
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
			this.invoke(publisher, () => publisher.publishAll?.(envelopes)),
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
				this.invoke(publisher, () => publisher.publish(envelope)),
				this.publisherTimeout,
				() => `Publishing event "${show(envelope?.event)}" with ${handler}`,
			);
			const report = (settled: Settled) =>
				this.reportPublisherFailure(handler, [envelope], settled, `event "${show(envelope?.event)}"`);
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
