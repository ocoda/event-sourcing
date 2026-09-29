// ADR 0001 §2, the publishing pipeline. The ADR's test-plan row "§2 publishing": a publisher that throws, rejects or
// hangs doesn't fail the append, the others still receive, deliveryErrors$ emits and the order holds; a conflict
// publishes nothing. The bootstrap half ("app.close() drains, then disconnects once") is event-bus.shutdown.spec.ts.
import { Logger } from '@nestjs/common';
import {
	EventBus,
	type EventDeliveryError,
	EventEnvelope,
	EventStoreVersionConflictException,
	EventStream,
	type IEventPublisher,
	type IEventSubscriber,
} from '@ocoda/event-sourcing';
import { Account, AccountId, getEventMap, getEvents } from '@ocoda/event-sourcing-testing/unit';
import { InMemoryEventStore } from '@ocoda/event-sourcing/integration/event-store';
import type { MockInstance } from 'vitest';

/**
 * A promise that the test settles, to hold a publisher or a subscriber until then.
 */
const deferred = <T = void>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const envelopeFor = (version: number, event = 'publishing-recorded') =>
	EventEnvelope.create(event, {}, { aggregateId: 'a', version });

const recordDeliveryErrors = (bus: EventBus): EventDeliveryError[] => {
	const errors: EventDeliveryError[] = [];
	bus.deliveryErrors$.subscribe((error) => errors.push(error));
	return errors;
};

const newStream = () => EventStream.for(Account, AccountId.generate());

describe('EventBus publishing (ADR 0001 §2)', () => {
	const eventMap = getEventMap();
	const events = getEvents();

	let loggerError: MockInstance;
	let loggerWarn: MockInstance;

	beforeEach(() => {
		loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
		loggerWarn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
		vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const createStore = async (publishing?: { publisherTimeout?: number }) => {
		const bus = new EventBus({ publishing });
		const store = new InMemoryEventStore({ eventMap, publisher: bus }, { driver: InMemoryEventStore });
		await store.connect();
		await store.ensureCollection();
		return { bus, store, deliveryErrors: recordDeliveryErrors(bus) };
	};

	describe('publishers', () => {
		class HealthyPublisher implements IEventPublisher {
			readonly calls: EventEnvelope[] = [];
			async publish(envelope: EventEnvelope): Promise<void> {
				this.calls.push(envelope);
				await sleep(1);
			}
		}
		class ThrowingPublisher implements IEventPublisher {
			readonly calls: EventEnvelope[] = [];
			publish(envelope: EventEnvelope): void {
				this.calls.push(envelope);
				throw new Error('broker misconfigured');
			}
		}
		class RejectingPublisher implements IEventPublisher {
			readonly calls: EventEnvelope[] = [];
			async publish(envelope: EventEnvelope): Promise<void> {
				this.calls.push(envelope);
				throw new Error('broker unavailable');
			}
		}
		class HangingPublisher implements IEventPublisher {
			readonly calls: EventEnvelope[] = [];
			publish(envelope: EventEnvelope): Promise<void> {
				this.calls.push(envelope);
				return new Promise(() => undefined);
			}
		}

		it.each([
			['throws', ThrowingPublisher, new Error('broker misconfigured')],
			['rejects', RejectingPublisher, new Error('broker unavailable')],
			[
				'hangs',
				HangingPublisher,
				expect.objectContaining({
					name: 'TimeoutError',
					message: expect.stringMatching(
						/^Publishing event "account-\w+" with HangingPublisher took longer than 20 ms$/,
					),
				}),
			],
		])(
			'a publisher that %s: the append resolves, the others still receive, deliveryErrors$ emits and the order holds',
			async (_, FailingPublisher: new () => IEventPublisher & { calls: EventEnvelope[] }, expectedError) => {
				const { bus, store, deliveryErrors } = await createStore({ publisherTimeout: 20 });
				const before = new HealthyPublisher();
				const failing = new FailingPublisher();
				const after = new HealthyPublisher();
				const subscriber = { handle: vi.fn() } satisfies IEventSubscriber;
				bus.addPublisher(before);
				bus.addPublisher(failing);
				bus.addPublisher(after);
				bus.bind(subscriber, '');

				const envelopes = await store.appendEvents(newStream(), events.slice(0, 3), { expectedVersion: 0 });
				await bus.whenIdle({ timeout: 1_000 });

				expect(envelopes).toHaveLength(3);
				// Every publisher gets every envelope, in commit order, the failing one included
				for (const publisher of [before, failing, after]) {
					expect(publisher.calls).toEqual(envelopes);
				}
				expect(subscriber.handle.mock.calls).toEqual(envelopes.map((envelope) => [envelope]));
				expect(deliveryErrors).toEqual(
					envelopes.map((envelope) => ({
						kind: 'publisher',
						handler: FailingPublisher.name,
						envelope,
						error: expectedError,
					})),
				);
				expect(loggerError.mock.calls.map(([message]) => message)).toEqual(
					envelopes.map(({ event }) => `Event publisher ${FailingPublisher.name} failed to publish event "${event}"`),
				);
			},
		);

		it('reports a timeout as a DOMException named TimeoutError', async () => {
			const bus = new EventBus({ publishing: { publisherTimeout: 5 } });
			const deliveryErrors = recordDeliveryErrors(bus);
			bus.addPublisher(new HangingPublisher());

			await bus.publishAll([envelopeFor(1)]);

			const [{ error }] = deliveryErrors;
			expect(error).toBeInstanceOf(DOMException);
			expect(error).toBeInstanceOf(Error);
			expect(error).toMatchObject({ name: 'TimeoutError', code: DOMException.TIMEOUT_ERR });
			expect(loggerError.mock.calls[0][1]).toContain('TimeoutError: Publishing event "publishing-recorded"');
		});

		it('awaits an asynchronous publisher: the append resolves once the publisher settled', async () => {
			const { bus, store } = await createStore();
			const gate = deferred();
			const publisher = { publish: vi.fn(() => gate.promise) };
			bus.addPublisher(publisher);
			let appended = false;

			const appending = store
				.appendEvents(newStream(), events.slice(0, 1), { expectedVersion: 0 })
				.then(() => (appended = true));
			await vi.waitFor(() => expect(publisher.publish).toHaveBeenCalledTimes(1));
			await sleep(5);
			expect(appended).toBe(false);
			gate.resolve();
			await appending;

			expect(appended).toBe(true);
		});

		it('runs the publishers concurrently: a slow publisher holds back neither the others nor their later envelopes', async () => {
			const bus = new EventBus();
			const gate = deferred();
			const slow = { publish: vi.fn(() => gate.promise) };
			const fast = { publish: vi.fn(async () => undefined) };
			bus.addPublisher(slow);
			bus.addPublisher(fast);
			const envelopes = [envelopeFor(1), envelopeFor(2), envelopeFor(3)];

			const publishing = bus.publishAll(envelopes);
			await vi.waitFor(() => expect(fast.publish).toHaveBeenCalledTimes(3));
			expect(slow.publish).toHaveBeenCalledTimes(1);
			gate.resolve();
			await publishing;

			expect(slow.publish.mock.calls).toEqual(envelopes.map((envelope) => [envelope]));
		});

		it('delivers to a publisher in order, one call at a time, whatever each call takes', async () => {
			const bus = new EventBus();
			const log: string[] = [];
			bus.addPublisher({
				publish: async ({ metadata: { version } }: EventEnvelope) => {
					log.push(`start ${version}`);
					// The earlier envelopes take longer, so an unordered delivery would finish them last
					await sleep(10 - 3 * version);
					log.push(`end ${version}`);
				},
			});

			await bus.publishAll([envelopeFor(1), envelopeFor(2), envelopeFor(3)]);

			expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
		});

		it('delivers the appends to a publisher in commit order, even when an append commits while the previous one is still being published', async () => {
			const { bus, store, deliveryErrors } = await createStore();
			const gate = deferred();
			const published: number[] = [];
			// For example a broker producer keyed by the aggregate id, that is still sending version 1
			bus.addPublisher({
				publish: ({ metadata: { version } }: EventEnvelope) => {
					published.push(version);
					return version === 1 ? gate.promise : undefined;
				},
			});
			const stream = newStream();
			let firstAppended = false;
			let secondAppended = false;

			// One command appends versions 1 and 2 ...
			const first = store
				.appendEvents(stream, events.slice(0, 2), { expectedVersion: 0 })
				.then(() => (firstAppended = true));
			await vi.waitFor(() => expect(published).toEqual([1]));
			// ... and another one, which loaded the stream at version 2, appends version 3 while version 1 is being sent
			const second = store
				.appendEvents(stream, events.slice(2, 3), { expectedVersion: 2 })
				.then(() => (secondAppended = true));
			await sleep(5);
			expect(published).toEqual([1]);
			expect({ firstAppended, secondAppended }).toEqual({ firstAppended: false, secondAppended: false });
			gate.resolve();
			await Promise.all([first, second]);

			expect(published).toEqual([1, 2, 3]);
			expect(deliveryErrors).toEqual([]);
		});

		it('holds back only the publisher that is still busy: the others get the next append at once', async () => {
			const bus = new EventBus();
			const gate = deferred();
			const slow = { publish: vi.fn((_envelope: EventEnvelope) => gate.promise) };
			const fast = { publish: vi.fn(async (_envelope: EventEnvelope) => undefined) };
			const synchronous = { publish: vi.fn((_envelope: EventEnvelope) => undefined) };
			bus.addPublisher(slow);
			bus.addPublisher(fast);
			bus.addPublisher(synchronous);
			const [first, second] = [envelopeFor(1), envelopeFor(2)];

			const publishing = [bus.publishAll([first]), bus.publishAll([second])];
			// A synchronous publisher is called within publishAll
			expect(synchronous.publish.mock.calls).toEqual([[first], [second]]);
			await vi.waitFor(() => expect(fast.publish).toHaveBeenCalledTimes(2));
			expect(slow.publish.mock.calls).toEqual([[first]]);
			gate.resolve();
			await Promise.all(publishing);

			expect(slow.publish.mock.calls).toEqual([[first], [second]]);
			expect(fast.publish.mock.calls).toEqual([[first], [second]]);
		});

		it('queues the appends for a publisher that implements publishAll, one call at a time', async () => {
			const bus = new EventBus();
			const gate = deferred();
			const publishAll = vi.fn((envelopes: readonly EventEnvelope[]) =>
				envelopes[0]?.metadata.version === 1 ? gate.promise : Promise.resolve(),
			);
			bus.addPublisher({ publish: vi.fn(), publishAll });
			const [first, second, third] = [envelopeFor(1), envelopeFor(2), envelopeFor(3)];

			const publishing = [bus.publishAll([first, second]), bus.publishAll([third])];
			await sleep(5);
			expect(publishAll.mock.calls).toEqual([[[first, second]]]);
			gate.resolve();
			await Promise.all(publishing);

			expect(publishAll.mock.calls).toEqual([[[first, second]], [[third]]]);
		});

		it.each([
			['rejects', () => Promise.reject(new Error('broker unavailable')), 'Error'],
			['hangs', () => new Promise<void>(() => undefined), 'TimeoutError'],
		])('goes on with the next append once a queued call %s', async (_, failingCall: () => Promise<void>, errorName) => {
			const bus = new EventBus({ publishing: { publisherTimeout: 5 } });
			const deliveryErrors = recordDeliveryErrors(bus);
			const publish = vi.fn(({ metadata: { version } }: EventEnvelope) =>
				version === 1 ? failingCall() : Promise.resolve(),
			);
			bus.addPublisher({ publish });
			const [first, second] = [envelopeFor(1), envelopeFor(2)];

			await Promise.all([bus.publishAll([first]), bus.publishAll([second])]);

			expect(publish.mock.calls).toEqual([[first], [second]]);
			expect(deliveryErrors).toEqual([
				expect.objectContaining({ envelope: first, error: expect.objectContaining({ name: errorName }) }),
			]);
		});

		it('calls a publisher at once again once it caught up, and waits in whenIdle for the queued appends', async () => {
			const bus = new EventBus();
			const gate = deferred();
			const publish = vi.fn(({ metadata: { version } }: EventEnvelope) =>
				version === 1 ? gate.promise : Promise.resolve(),
			);
			bus.addPublisher({ publish });
			let idle = false;

			const publishing = [bus.publishAll([envelopeFor(1)]), bus.publishAll([envelopeFor(2)])];
			const waiting = bus.whenIdle().then(() => (idle = true));
			await sleep(5);
			expect(idle).toBe(false);
			gate.resolve();
			await waiting;
			expect(publish).toHaveBeenCalledTimes(2);
			await Promise.all(publishing);

			void bus.publishAll([envelopeFor(3)]);
			expect(publish).toHaveBeenCalledTimes(3);
			await bus.whenIdle();
		});

		it('publishes nothing for a conflicting append', async () => {
			const { bus, store, deliveryErrors } = await createStore();
			const stream = newStream();
			await store.appendEvents(stream, events.slice(0, 1), { expectedVersion: 0 });
			const publisher = { publish: vi.fn(), publishAll: undefined };
			const subscriber = { handle: vi.fn() };
			bus.addPublisher(publisher);
			bus.bind(subscriber, '');

			await expect(store.appendEvents(stream, events.slice(1, 2), { expectedVersion: 0 })).rejects.toBeInstanceOf(
				EventStoreVersionConflictException,
			);
			await bus.whenIdle({ timeout: 1_000 });

			expect(publisher.publish).not.toHaveBeenCalled();
			expect(subscriber.handle).not.toHaveBeenCalled();
			expect(deliveryErrors).toEqual([]);
		});

		it('publishes only the winner of concurrent appends at the same expected version', async () => {
			const { bus, store } = await createStore();
			const stream = newStream();
			const publisher = {
				publishAll: vi.fn(async (_envelopes: readonly EventEnvelope[]) => undefined),
				publish: vi.fn(),
			};
			bus.addPublisher(publisher);

			const results = await Promise.allSettled(
				Array.from({ length: 4 }, (_, writer) =>
					store.appendEvents(stream, [events[writer % events.length]], { expectedVersion: 0 }),
				),
			);

			const winners = results.filter((result) => result.status === 'fulfilled');
			expect(winners).toHaveLength(1);
			expect(publisher.publishAll.mock.calls).toEqual([[winners[0].value]]);
		});

		it('times a call out after 30 s by default', async () => {
			vi.useFakeTimers();
			const bus = new EventBus();
			const deliveryErrors = recordDeliveryErrors(bus);
			bus.addPublisher({ publish: () => new Promise(() => undefined) });
			let published = false;

			const publishing = bus.publishAll([envelopeFor(1)]).then(() => (published = true));
			await vi.advanceTimersByTimeAsync(29_999);
			expect(published).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await publishing;

			expect(deliveryErrors).toEqual([
				expect.objectContaining({
					kind: 'publisher',
					handler: 'Object',
					error: expect.objectContaining({ name: 'TimeoutError', message: expect.stringContaining('30000 ms') }),
				}),
			]);
		});

		it.each([
			['0', 0],
			['Infinity', Number.POSITIVE_INFINITY],
			['above the timer range', 2 ** 31],
		])('never times a call out with a publisherTimeout of %s', async (_, publisherTimeout) => {
			vi.useFakeTimers();
			const bus = new EventBus({ publishing: { publisherTimeout } });
			const deliveryErrors = recordDeliveryErrors(bus);
			const gate = deferred();
			bus.addPublisher({ publish: () => gate.promise });
			let published = false;

			const publishing = bus.publishAll([envelopeFor(1)]).then(() => (published = true));
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
			expect(published).toBe(false);
			gate.resolve();
			await publishing;

			expect(deliveryErrors).toEqual([]);
		});

		it('handles a call that settles after its timeout without reporting it again', async () => {
			const bus = new EventBus({ publishing: { publisherTimeout: 5 } });
			const deliveryErrors = recordDeliveryErrors(bus);
			const gate = deferred();
			bus.addPublisher({ publish: () => gate.promise });

			await bus.publishAll([envelopeFor(1)]);
			// A rejection nobody handled would fail the test run
			gate.reject(new Error('late failure'));
			await sleep(5);

			expect(deliveryErrors).toEqual([
				expect.objectContaining({ error: expect.objectContaining({ name: 'TimeoutError' }) }),
			]);
		});

		it('clears the timer of a call that settles in time', async () => {
			vi.useFakeTimers();
			const bus = new EventBus();
			const gate = deferred();
			bus.addPublisher({ publish: () => gate.promise });

			const publishing = bus.publishAll([envelopeFor(1)]);
			expect(vi.getTimerCount()).toBe(1);
			gate.resolve();
			await publishing;

			expect(vi.getTimerCount()).toBe(0);
		});

		it('calls publishAll instead of publish for a publisher that implements it, once per append', async () => {
			const { bus, store, deliveryErrors } = await createStore();
			const publisher = {
				publish: vi.fn(),
				publishAll: vi.fn(async (_envelopes: readonly EventEnvelope[]) => undefined),
			} satisfies IEventPublisher;
			bus.addPublisher(publisher);

			const envelopes = await store.appendEvents(newStream(), events.slice(0, 3), { expectedVersion: 0 });

			expect(publisher.publish).not.toHaveBeenCalled();
			expect(publisher.publishAll).toHaveBeenCalledTimes(1);
			const [published] = publisher.publishAll.mock.calls[0];
			expect(published).toEqual(envelopes);
			// Its own frozen copy: a publisher can't change what the others get, nor the envelopes the append returns
			expect(Object.isFrozen(published)).toBe(true);
			expect(published).not.toBe(envelopes);
			expect(deliveryErrors).toEqual([]);
		});

		it.each([
			[
				'throws',
				() => {
					throw new Error('batch failure');
				},
				new Error('batch failure'),
			],
			['rejects', () => Promise.reject(new Error('batch failure')), new Error('batch failure')],
			[
				'hangs',
				() => new Promise<void>(() => undefined),
				expect.objectContaining({
					name: 'TimeoutError',
					message: 'Publishing 3 event(s) with BatchPublisher took longer than 5 ms',
				}),
			],
		])(
			'reports every envelope of a publishAll call that %s, and logs it once',
			async (_, publishAll, expectedError) => {
				const bus = new EventBus({ publishing: { publisherTimeout: 5 } });
				const deliveryErrors = recordDeliveryErrors(bus);
				class BatchPublisher implements IEventPublisher {
					publish = vi.fn();
					publishAll = publishAll;
				}
				bus.addPublisher(new BatchPublisher());
				const envelopes = [envelopeFor(1), envelopeFor(2), envelopeFor(3)];

				await expect(bus.publishAll(envelopes)).resolves.toBeUndefined();

				expect(deliveryErrors).toEqual(
					envelopes.map((envelope) => ({
						kind: 'publisher',
						handler: 'BatchPublisher',
						envelope,
						error: expectedError,
					})),
				);
				expect(loggerError).toHaveBeenCalledTimes(1);
				expect(loggerError.mock.calls[0][0]).toBe('Event publisher BatchPublisher failed to publish 3 event(s)');
			},
		);

		it('publish() returns a promise that awaits the publishers and never rejects', async () => {
			const bus = new EventBus();
			const gate = deferred();
			bus.addPublisher({ publish: () => gate.promise });
			bus.addPublisher({
				publish: () => {
					throw new Error('failure');
				},
			});
			let published = false;

			const publishing = bus.publish(envelopeFor(1)).then(() => (published = true));
			await sleep(5);
			expect(published).toBe(false);
			gate.resolve();

			await expect(publishing).resolves.toBe(true);
			expectTypeOf(bus.publish).returns.toEqualTypeOf<Promise<void>>();
		});

		it('keeps accepting the 3.x publishers, which may return anything', () => {
			class KafkaPublisher implements IEventPublisher {
				async publish(): Promise<{ partition: number }[]> {
					return [{ partition: 0 }];
				}
			}
			class ClientProxyPublisher implements IEventPublisher {
				publish(): { subscribe(): void } {
					return { subscribe: () => undefined };
				}
			}

			expectTypeOf<KafkaPublisher>().toExtend<IEventPublisher>();
			expectTypeOf<ClientProxyPublisher>().toExtend<IEventPublisher>();
		});
	});

	describe('subscribers', () => {
		it('reports a failing subscriber on deliveryErrors$ and keeps it subscribed', async () => {
			const bus = new EventBus();
			const deliveryErrors = recordDeliveryErrors(bus);
			class FailingSubscriber implements IEventSubscriber {
				async handle(): Promise<void> {
					throw new Error('projection down');
				}
			}
			bus.bind(new FailingSubscriber(), 'publishing-recorded');
			const envelopes = [envelopeFor(1), envelopeFor(2)];

			await bus.publishAll(envelopes);
			await bus.whenIdle({ timeout: 1_000 });

			expect(deliveryErrors).toEqual(
				envelopes.map((envelope) => ({
					kind: 'subscriber',
					handler: 'FailingSubscriber',
					envelope,
					error: new Error('projection down'),
				})),
			);
		});

		it("doesn't make an append wait for the subscribers; whenIdle does", async () => {
			const { bus, store } = await createStore();
			const gate = deferred();
			const subscriber = { handle: vi.fn(() => gate.promise) };
			bus.bind(subscriber, '');
			let idle = false;

			await store.appendEvents(newStream(), events.slice(0, 2), { expectedVersion: 0 });
			expect(subscriber.handle).toHaveBeenCalledTimes(2);
			const waiting = bus.whenIdle().then(() => (idle = true));
			await sleep(5);
			expect(idle).toBe(false);
			gate.resolve();
			await waiting;

			expect(idle).toBe(true);
		});
	});

	describe('whenIdle', () => {
		it('resolves at once when nothing runs', async () => {
			await expect(new EventBus().whenIdle()).resolves.toBeUndefined();
			await expect(new EventBus().whenIdle({ timeout: 1 })).resolves.toBeUndefined();
		});

		it('waits for a publication that is still running', async () => {
			const bus = new EventBus();
			const gate = deferred();
			bus.addPublisher({ publish: () => gate.promise });
			let idle = false;

			void bus.publish(envelopeFor(1));
			const waiting = bus.whenIdle().then(() => (idle = true));
			await sleep(5);
			expect(idle).toBe(false);
			gate.resolve();
			await waiting;

			expect(idle).toBe(true);
		});

		it('rejects with a TimeoutError when the bus is still busy after the timeout', async () => {
			const bus = new EventBus();
			const gate = deferred();
			bus.bind({ handle: () => gate.promise }, '');
			await bus.publish(envelopeFor(1));

			const error = await bus.whenIdle({ timeout: 10 }).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(DOMException);
			expect(error).toMatchObject({
				name: 'TimeoutError',
				message: 'The event bus is not idle after 10 ms: 0 publication(s) and 1 subscriber call(s) are still running',
			});
			gate.resolve();
			await expect(bus.whenIdle({ timeout: 1_000 })).resolves.toBeUndefined();
		});

		it('waits as long as it takes with a timeout of 0', async () => {
			vi.useFakeTimers();
			const bus = new EventBus();
			const gate = deferred();
			bus.bind({ handle: () => gate.promise }, '');
			await bus.publish(envelopeFor(1));
			let idle = false;

			const waiting = bus.whenIdle({ timeout: 0 }).then(() => (idle = true));
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);
			expect(idle).toBe(false);
			gate.resolve();
			await waiting;
		});

		it.each([[-1], [Number.NaN], ['10']])('rejects the timeout %s with a RangeError', async (timeout) => {
			await expect(new EventBus().whenIdle({ timeout: timeout as number })).rejects.toThrow(
				new RangeError(
					`Not a timeout for whenIdle: ${String(timeout)}. Expected a number of milliseconds, or 0 to disable it.`,
				),
			);
		});
	});

	describe('options', () => {
		it.each([
			[{ publisherTimeout: -1 }, 'publishing.publisherTimeout: -1'],
			[{ publisherTimeout: Number.NaN }, 'publishing.publisherTimeout: NaN'],
			[{ publisherTimeout: '30' }, 'publishing.publisherTimeout: 30'],
			[{ shutdownTimeout: -5 }, 'publishing.shutdownTimeout: -5'],
		])('rejects the publishing options %o with a RangeError', (publishing, detail) => {
			expect(() => new EventBus({ publishing } as never)).toThrow(
				new RangeError(`Not a timeout for ${detail}. Expected a number of milliseconds, or 0 to disable it.`),
			);
		});

		it('takes the defaults for omitted options', () => {
			expect(() => new EventBus()).not.toThrow();
			expect(() => new EventBus({})).not.toThrow();
			expect(() => new EventBus({ publishing: {} })).not.toThrow();
			expect(
				() => new EventBus({ publishing: { publisherTimeout: null, shutdownTimeout: null } } as never),
			).not.toThrow();
		});
	});

	describe('shutdown', () => {
		it('waits for the running subscribers before the application shuts down', async () => {
			const bus = new EventBus();
			const gate = deferred();
			bus.bind({ handle: () => gate.promise }, '');
			await bus.publish(envelopeFor(1));
			let drained = false;

			const shuttingDown = bus.beforeApplicationShutdown().then(() => (drained = true));
			await sleep(5);
			expect(drained).toBe(false);
			gate.resolve();
			await shuttingDown;

			expect(drained).toBe(true);
			expect(loggerWarn).not.toHaveBeenCalled();
		});

		it('gives up waiting after 10 s by default, with a warning', async () => {
			vi.useFakeTimers();
			const bus = new EventBus();
			bus.bind({ handle: () => new Promise(() => undefined) }, '');
			await bus.publish(envelopeFor(1));
			let drained = false;

			const shuttingDown = bus.beforeApplicationShutdown().then(() => (drained = true));
			await vi.advanceTimersByTimeAsync(9_999);
			expect(drained).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await shuttingDown;

			expect(loggerWarn).toHaveBeenCalledWith(
				'The event bus is not idle after 10000 ms: 0 publication(s) and 1 subscriber call(s) are still running; shutting down anyway',
			);
		});

		it('gives up waiting after the shutdownTimeout', async () => {
			const bus = new EventBus({ publishing: { shutdownTimeout: 5 } });
			bus.bind({ handle: () => new Promise(() => undefined) }, '');
			await bus.publish(envelopeFor(1));

			await expect(bus.beforeApplicationShutdown()).resolves.toBeUndefined();

			expect(loggerWarn).toHaveBeenCalledTimes(1);
		});

		it('unsubscribes the subscribers once the application has shut down, which ends their tracking', async () => {
			const bus = new EventBus();
			const subscriber = { handle: vi.fn(() => new Promise<void>(() => undefined)) };
			bus.bind(subscriber, '');
			await bus.publish(envelopeFor(1));

			bus.onApplicationShutdown();
			await bus.publish(envelopeFor(2));

			expect(subscriber.handle).toHaveBeenCalledTimes(1);
			await expect(bus.whenIdle({ timeout: 1_000 })).resolves.toBeUndefined();
		});
	});
});
