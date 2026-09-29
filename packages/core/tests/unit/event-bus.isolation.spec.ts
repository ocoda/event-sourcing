import { Logger } from '@nestjs/common';
import {
	CommandBus,
	Event,
	EventBus,
	EventEnvelope,
	EventId,
	type ICommand,
	type IEvent,
	type IEventPublisher,
	type IEventSubscriber,
	UUID,
	eventFilter,
} from '@ocoda/event-sourcing';
import { COMMAND_METADATA } from '@ocoda/event-sourcing/decorators';
import { config } from 'rxjs';
import type { Mock, MockInstance } from 'vitest';

describe('EventBus isolation', () => {
	@Event('isolation-account-opened')
	class AccountOpenedEvent implements IEvent {}

	@Event('isolation-account-closed')
	// oxlint-disable-next-line no-unused-vars -- only declared to run its decorators
	class AccountClosedEvent implements IEvent {}

	const envelopeFor = (event: string, version = 1) =>
		EventEnvelope.create(event, {}, { aggregateId: UUID.generate().value, eventId: EventId.generate(), version });

	let loggerError: MockInstance;
	let unhandledRxjsErrors: unknown[];
	let originalOnUnhandledError: typeof config.onUnhandledError;

	beforeEach(() => {
		loggerError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

		// rxjs reports errors that nobody handles (e.g. rethrown from an error callback) asynchronously,
		// which crashes the process with an uncaughtException. Capture them to assert nothing escapes.
		unhandledRxjsErrors = [];
		originalOnUnhandledError = config.onUnhandledError;
		config.onUnhandledError = (error) => unhandledRxjsErrors.push(error);
	});

	afterEach(() => {
		config.onUnhandledError = originalOnUnhandledError;
		loggerError.mockRestore();
	});

	describe('subscribers', () => {
		class ThrowingSubscriber implements IEventSubscriber {
			handle = vi.fn((_envelope: EventEnvelope): void => {
				throw new Error('sync subscriber failure');
			});
		}

		class RejectingSubscriber implements IEventSubscriber {
			handle = vi.fn(async (_envelope: EventEnvelope): Promise<void> => {
				throw new Error('async subscriber failure');
			});
		}

		class HealthySubscriber implements IEventSubscriber {
			handle = vi.fn(async (_envelope: EventEnvelope): Promise<void> => undefined);
		}

		it.each([
			['synchronously throws', ThrowingSubscriber, 'sync subscriber failure'],
			['returns a rejected promise', RejectingSubscriber, 'async subscriber failure'],
		])(
			'keeps delivering events when a subscriber %s',
			async (_, FailingSubscriber: new () => IEventSubscriber & { handle: Mock }, message) => {
				const bus = new EventBus();
				const failing = new FailingSubscriber();
				const healthy = new HealthySubscriber();
				const catchAll = new HealthySubscriber();

				bus.bind(failing, 'isolation-account-opened');
				bus.bind(healthy, 'isolation-account-opened');
				bus.bind(catchAll, '');

				const first = envelopeFor('isolation-account-opened', 1);
				const second = envelopeFor('isolation-account-opened', 2);
				const third = envelopeFor('isolation-account-closed', 3);

				await expect(bus.publish(first)).resolves.toBeUndefined();
				await bus.whenIdle({ timeout: 1_000 });
				await expect(bus.publish(second)).resolves.toBeUndefined();
				await expect(bus.publish(third)).resolves.toBeUndefined();
				await bus.whenIdle({ timeout: 1_000 });

				// the failing subscriber stays subscribed and receives every matching event
				expect(failing.handle).toHaveBeenCalledTimes(2);
				expect(failing.handle).toHaveBeenNthCalledWith(1, first);
				expect(failing.handle).toHaveBeenNthCalledWith(2, second);

				// other subscribers are not affected
				expect(healthy.handle).toHaveBeenCalledTimes(2);
				expect(catchAll.handle.mock.calls).toEqual([[first], [second], [third]]);

				// every failure is logged with the event and the subscriber
				expect(loggerError).toHaveBeenCalledTimes(2);
				for (const [logMessage, trace] of loggerError.mock.calls) {
					expect(logMessage).toBe(
						`Event subscriber ${FailingSubscriber.name} failed to handle event "isolation-account-opened"`,
					);
					expect(trace).toContain(message);
				}

				// nothing escapes as an unhandled error
				expect(unhandledRxjsErrors).toEqual([]);
				expect((bus as any).subscriptions.every((subscription) => !subscription.closed)).toBe(true);
			},
		);

		it('still invokes subscribers synchronously on publish', () => {
			const bus = new EventBus();
			const healthy = new HealthySubscriber();
			bus.bind(healthy, 'isolation-account-opened');

			const envelope = envelopeFor('isolation-account-opened');
			bus.publish(envelope);

			expect(healthy.handle).toHaveBeenCalledWith(envelope);
		});
	});

	describe('publishers', () => {
		class ThrowingPublisher implements IEventPublisher {
			publish = vi.fn((_envelope: EventEnvelope): void => {
				throw new Error('sync publisher failure');
			});
		}

		class RejectingPublisher implements IEventPublisher {
			publish = vi.fn(async (_envelope: EventEnvelope): Promise<void> => {
				throw new Error('async publisher failure');
			});
		}

		class HealthyPublisher implements IEventPublisher {
			publish = vi.fn(async (_envelope: EventEnvelope): Promise<void> => undefined);
		}

		it('publishes to the remaining publishers and logs failures of throwing or rejecting publishers', async () => {
			const bus = new EventBus();
			const throwing = new ThrowingPublisher();
			const rejecting = new RejectingPublisher();
			const healthy = new HealthyPublisher();
			const subscriber = { handle: vi.fn() };

			bus.addPublisher(throwing);
			bus.addPublisher(rejecting);
			bus.addPublisher(healthy);
			bus.bind(subscriber, 'isolation-account-opened');

			const first = envelopeFor('isolation-account-opened', 1);
			const second = envelopeFor('isolation-account-opened', 2);

			// publish never rejects, and resolves once the publishers settled
			await expect(bus.publish(first)).resolves.toBeUndefined();
			await expect(bus.publish(second)).resolves.toBeUndefined();

			for (const publisher of [throwing, rejecting, healthy]) {
				expect(publisher.publish.mock.calls).toEqual([[first], [second]]);
			}
			// the default publisher (in-process subscribers) keeps working
			expect(subscriber.handle.mock.calls).toEqual([[first], [second]]);

			const logged = loggerError.mock.calls.map(([logMessage, trace]) => ({ logMessage, trace }));
			expect(logged).toHaveLength(4);
			expect(logged.filter(({ logMessage }) => logMessage.startsWith('Event publisher ThrowingPublisher'))).toEqual([
				{
					logMessage: 'Event publisher ThrowingPublisher failed to publish event "isolation-account-opened"',
					trace: expect.stringContaining('sync publisher failure'),
				},
				{
					logMessage: 'Event publisher ThrowingPublisher failed to publish event "isolation-account-opened"',
					trace: expect.stringContaining('sync publisher failure'),
				},
			]);
			expect(logged.filter(({ logMessage }) => logMessage.startsWith('Event publisher RejectingPublisher'))).toEqual([
				{
					logMessage: 'Event publisher RejectingPublisher failed to publish event "isolation-account-opened"',
					trace: expect.stringContaining('async publisher failure'),
				},
				{
					logMessage: 'Event publisher RejectingPublisher failed to publish event "isolation-account-opened"',
					trace: expect.stringContaining('async publisher failure'),
				},
			]);
		});

		it('logs non-error rejection reasons', async () => {
			const bus = new EventBus();
			bus.addPublisher({ publish: () => Promise.reject('plain reason') });

			await bus.publish(envelopeFor('isolation-account-opened'));

			expect(loggerError).toHaveBeenCalledWith(
				'Event publisher Object failed to publish event "isolation-account-opened"',
				'plain reason',
			);
		});
	});

	describe('observable bus', () => {
		it('emits published envelopes when subscribing to the event bus itself', () => {
			const bus = new EventBus();
			const opened: EventEnvelope[] = [];
			const all: EventEnvelope[] = [];

			const openedSubscription = bus
				.pipe(eventFilter(AccountOpenedEvent))
				.subscribe((envelope) => opened.push(envelope));
			const allSubscription = bus.subscribe((envelope) => all.push(envelope));

			const first = envelopeFor('isolation-account-opened', 1);
			const second = envelopeFor('isolation-account-closed', 2);
			bus.publish(first);
			bus.publish(second);

			openedSubscription.unsubscribe();
			allSubscription.unsubscribe();

			expect(opened).toEqual([first]);
			expect(all).toEqual([first, second]);
		});

		it('keeps exposing the underlying subject', () => {
			const bus = new EventBus();
			const received: EventEnvelope[] = [];
			const subscription = bus.subject$.subscribe((envelope) => received.push(envelope));

			const envelope = envelopeFor('isolation-account-opened');
			bus.publish(envelope);
			subscription.unsubscribe();

			expect(received).toEqual([envelope]);
		});

		it('emits executed commands when subscribing to the command bus itself', async () => {
			class OpenAccountCommand implements ICommand {}
			Reflect.defineMetadata(COMMAND_METADATA, { id: 'isolation-open-account' }, OpenAccountCommand);

			const bus = new CommandBus();
			bus.bind({ execute: async () => 'opened' }, 'isolation-open-account');

			const received: ICommand[] = [];
			const subscription = bus.subscribe((command) => received.push(command));

			const command = new OpenAccountCommand();
			await expect(bus.execute(command)).resolves.toBe('opened');
			subscription.unsubscribe();

			expect(received).toEqual([command]);
		});
	});
});
