// INTERIM(H): the path of event stores that still override `appendEvents`, as 3.x stores did, and as the built-in
// database stores do until they implement the store contract together with schema v2. The finalize PR removes it.
import type { Logger } from '@nestjs/common';
import { ExpectedVersion } from '../constants.js';
import type { EventStore } from '../event-store.js';
import { UnsupportedOperationException } from '../exceptions/index.js';
import type { EnvelopePublisher } from '../interfaces/index.js';
import { EventEnvelope, type EventStream } from '../models/index.js';
import { normalizeAppendArguments } from './append-arguments.js';
import { validateAppendMetadata, validatePrebuiltEnvelopes } from './append-validation.js';

const legacyEventStores = new WeakSet<object>();

/**
 * Whether the store overrides `appendEvents` and runs on the interim legacy path.
 * @internal
 */
export const isLegacyEventStore = (store: object): boolean => legacyEventStores.has(store);

const describeError = (error: unknown): string =>
	error instanceof Error ? error.stack || error.message : String(error);

/**
 * A store on the legacy path stores no headers.
 */
const NO_HEADERS = { headers: false } as const;

/**
 * Wraps a store that overrides `appendEvents` the way 3.x did: its own `appendEvents` checks versions, serializes and
 * writes, and the wrapper publishes what it returns through the publisher of the store context. Publishing never
 * makes the append fail.
 *
 * The positional form is passed on as it is, with its 3.x behaviour, once its arguments are checked. The options form
 * is checked like the base class checks it, before any I/O, and passed on in the positional form as far as that form
 * can express it: an empty append returns no envelopes, `ExpectedVersion.Any` and metadata throw an
 * `UnsupportedOperationException`, and `publish: false` skips the publisher.
 * @internal
 */
export const createLegacyEventStoreProxy = <T extends EventStore<unknown>>(
	store: T,
	{ publisher, logger }: { publisher: EnvelopePublisher; logger: Logger },
): T => {
	const component = `${store.constructor.name} (a store that overrides appendEvents)`;

	/**
	 * The arguments to call the store's own `appendEvents` with, or undefined for an empty append in the options form.
	 */
	const forward = (args: unknown[]): { args: unknown[]; publish: boolean } | undefined => {
		const [stream, ...rest] = args;
		const append = normalizeAppendArguments(rest);
		if (append.positional) {
			return { args, publish: true };
		}
		if (append.items.length === 0) {
			return undefined;
		}

		validateAppendMetadata(append.metadata, NO_HEADERS, { component });
		validatePrebuiltEnvelopes(stream as EventStream, append.items, append.expectedVersion);
		for (const item of append.items) {
			if (item instanceof EventEnvelope) {
				const { correlationId, causationId, headers } = item.metadata;
				validateAppendMetadata({ correlationId, causationId, headers }, NO_HEADERS, {
					allowReservedKeys: true,
					component,
				});
			}
		}
		if (append.expectedVersion === ExpectedVersion.Any) {
			throw new UnsupportedOperationException({ operation: 'ExpectedVersion.Any', component });
		}
		const { correlationId, causationId } = (append.metadata ?? {}) as Record<string, unknown>;
		if ((correlationId !== undefined && correlationId !== null) || (causationId !== undefined && causationId !== null)) {
			throw new UnsupportedOperationException({ operation: 'append metadata', component });
		}
		return {
			args: [stream, append.expectedVersion + append.items.length, append.items, append.pool],
			publish: append.publish,
		};
	};

	const proxy = new Proxy(store, {
		get(target, propKey) {
			if (propKey !== 'appendEvents') {
				return Reflect.get(target, propKey);
			}
			return async function (this: unknown, ...args: unknown[]): Promise<EventEnvelope[]> {
				const forwarded = forward(args);
				if (!forwarded) {
					return [];
				}

				const envelopes: EventEnvelope[] = await (
					target.appendEvents as unknown as (...args: unknown[]) => Promise<EventEnvelope[]>
				).apply(this, forwarded.args);

				// The events are stored at this point: publishing must never make the append fail
				if (forwarded.publish) {
					try {
						await publisher.publishAll(envelopes);
					} catch (error) {
						logger.error(`Failed to publish ${envelopes?.length ?? 0} appended event(s)`, describeError(error));
					}
				}
				return envelopes;
			};
		},
	});

	legacyEventStores.add(proxy);
	return proxy;
};
