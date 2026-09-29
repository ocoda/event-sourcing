// ADR 0001 §2 on a Nest 12 application: `app.close()` drains the publishers and subscribers that are still running,
// then disconnects each store once, and the `publishing` options of forRoot and forRootAsync reach the EventBus.
import { type DynamicModule, Logger, type Provider } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
	Event,
	EventBus,
	type EventDeliveryError,
	type EventEnvelope,
	EventPublisher,
	EventSourcingModule,
	EventStore,
	EventStream,
	EventSubscriber,
	type IEvent,
	type IEventPublisher,
	type IEventSubscriber,
	SnapshotStore,
} from '@ocoda/event-sourcing';
import { Account, AccountId } from '@ocoda/event-sourcing-testing/unit';
import type { MockInstance } from 'vitest';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

@Event('shutdown-account-opened')
class AccountOpenedEvent implements IEvent {
	constructor(public readonly owner: string) {}
}

/**
 * What happened, in order, across the subscriber and the stores.
 */
const timeline: string[] = [];
let release: () => void = () => undefined;

@EventSubscriber(AccountOpenedEvent)
class SlowSubscriber implements IEventSubscriber {
	async handle({ event }: EventEnvelope): Promise<void> {
		timeline.push(`handling ${event}`);
		await new Promise<void>((resolve) => (release = resolve));
		timeline.push(`handled ${event}`);
	}
}

@EventSubscriber(AccountOpenedEvent)
class HangingSubscriber implements IEventSubscriber {
	handle(): Promise<void> {
		timeline.push('hanging');
		return new Promise(() => undefined);
	}
}

@EventPublisher()
class GatedPublisher implements IEventPublisher {
	async publish({ event }: EventEnvelope): Promise<void> {
		timeline.push(`publishing ${event}`);
		await new Promise<void>((resolve) => (release = resolve));
		timeline.push(`published ${event}`);
	}
}

@EventPublisher()
class HangingPublisher implements IEventPublisher {
	publish(): Promise<void> {
		return new Promise(() => undefined);
	}
}

describe('EventBus on a Nest application (ADR 0001 §2)', () => {
	let loggerWarn: MockInstance;
	let app: TestingModule | undefined;

	beforeEach(() => {
		timeline.length = 0;
		vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
		vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
		loggerWarn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
	});

	afterEach(async () => {
		release();
		await app?.close();
		app = undefined;
	});

	const bootstrap = async (root: DynamicModule, providers: Provider[]): Promise<TestingModule> => {
		app = await Test.createTestingModule({ imports: [root], providers }).compile();
		await app.init();
		return app;
	};

	/**
	 * Records the disconnects of both stores on the timeline, and still disconnects them.
	 */
	const recordDisconnects = (context: TestingModule) =>
		[context.get(EventStore), context.get(SnapshotStore)].map((store) => {
			const disconnect = store.disconnect.bind(store);
			return vi.spyOn(store, 'disconnect').mockImplementation(async () => {
				timeline.push(`disconnect ${store.constructor.name}`);
				await disconnect();
			});
		});

	const appendOpened = (context: TestingModule) =>
		context
			.get(EventStore)
			.appendEvents(EventStream.for(Account, AccountId.generate()), [new AccountOpenedEvent('ada')], {
				expectedVersion: 0,
			});

	it('app.close() drains the running subscribers, then disconnects each store once', async () => {
		const context = await bootstrap(EventSourcingModule.forRoot({ events: [AccountOpenedEvent] }), [SlowSubscriber]);
		const disconnects = recordDisconnects(context);

		await appendOpened(context);
		// The append doesn't wait for the subscriber
		expect(timeline).toEqual(['handling shutdown-account-opened']);

		const closing = context.close();
		await sleep(20);
		expect(timeline).toEqual(['handling shutdown-account-opened']);
		release();
		await closing;
		app = undefined;

		expect(timeline).toEqual([
			'handling shutdown-account-opened',
			'handled shutdown-account-opened',
			'disconnect InMemoryEventStore',
			'disconnect InMemorySnapshotStore',
		]);
		for (const disconnect of disconnects) {
			expect(disconnect).toHaveBeenCalledTimes(1);
		}
		expect(loggerWarn).not.toHaveBeenCalled();
	});

	it('app.close() drains a publication that is still running, then disconnects each store once', async () => {
		const context = await bootstrap(EventSourcingModule.forRoot({ events: [AccountOpenedEvent] }), [GatedPublisher]);
		const disconnects = recordDisconnects(context);

		// The append waits for the publisher
		const appending = appendOpened(context);
		await vi.waitFor(() => expect(timeline).toEqual(['publishing shutdown-account-opened']));
		const closing = context.close();
		await sleep(20);
		expect(timeline).toEqual(['publishing shutdown-account-opened']);
		release();
		await Promise.all([appending, closing]);
		app = undefined;

		expect(timeline).toEqual([
			'publishing shutdown-account-opened',
			'published shutdown-account-opened',
			'disconnect InMemoryEventStore',
			'disconnect InMemorySnapshotStore',
		]);
		for (const disconnect of disconnects) {
			expect(disconnect).toHaveBeenCalledTimes(1);
		}
		expect(loggerWarn).not.toHaveBeenCalled();
	});

	it('gives up draining after publishing.shutdownTimeout, with a warning, and still disconnects once', async () => {
		const context = await bootstrap(
			EventSourcingModule.forRoot({ events: [AccountOpenedEvent], publishing: { shutdownTimeout: 20 } }),
			[HangingSubscriber],
		);
		const disconnects = recordDisconnects(context);
		await appendOpened(context);

		await context.close();
		app = undefined;

		expect(timeline).toEqual(['hanging', 'disconnect InMemoryEventStore', 'disconnect InMemorySnapshotStore']);
		expect(loggerWarn).toHaveBeenCalledWith(
			'The event bus is not idle after 20 ms: 0 publication(s) and 1 subscriber call(s) are still running; shutting down anyway',
		);
		for (const disconnect of disconnects) {
			expect(disconnect).toHaveBeenCalledTimes(1);
		}
	});

	it.each([
		[
			'forRoot',
			() => EventSourcingModule.forRoot({ events: [AccountOpenedEvent], publishing: { publisherTimeout: 20 } }),
		],
		[
			'forRootAsync',
			() =>
				EventSourcingModule.forRootAsync({
					useFactory: async () => ({ events: [AccountOpenedEvent], publishing: { publisherTimeout: 20 } }),
				}),
		],
	])('takes the publisherTimeout from the options of %s', async (_, root) => {
		const context = await bootstrap(root(), [HangingPublisher]);
		const deliveryErrors: EventDeliveryError[] = [];
		context.get(EventBus).deliveryErrors$.subscribe((error) => deliveryErrors.push(error));

		const [envelope] = await appendOpened(context);

		expect(deliveryErrors).toEqual([
			{
				kind: 'publisher',
				handler: 'HangingPublisher',
				envelope,
				error: expect.objectContaining({
					name: 'TimeoutError',
					message: 'Publishing event "shutdown-account-opened" with HangingPublisher took longer than 20 ms',
				}),
			},
		]);
	});

	it('fails the bootstrap on an invalid publishing option', async () => {
		await expect(bootstrap(EventSourcingModule.forRoot({ publishing: { publisherTimeout: -1 } }), [])).rejects.toThrow(
			new RangeError(
				'Not a timeout for publishing.publisherTimeout: -1. Expected a number of milliseconds, or 0 to disable it.',
			),
		);
	});
});
