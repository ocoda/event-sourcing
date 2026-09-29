// INTERIM(H): the path of event stores that still override `appendEvents`, as 3.x stores did, and as the built-in
// database stores do until they implement the store contract together with schema v2. The finalize PR removes it.
import type { Logger } from '@nestjs/common';
import { ExpectedVersion } from '../constants.js';
import type { EventMap } from '../event-map.js';
import type { EventStore } from '../event-store.js';
import { UnsupportedOperationException } from '../exceptions/index.js';
import type { EnvelopePublisher } from '../interfaces/index.js';
import { EventEnvelope, EventId, type EventStream } from '../models/index.js';
import { type AppendItem, normalizeAppendArguments } from './append-arguments.js';
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
 * Both forms are checked before any I/O and passed on in the positional form, which is all such a store understands:
 * - the positional form keeps its 3.x behaviour once its arguments are checked: an empty append reaches the store, a
 *   gap is accepted, and pre-built envelopes are stored as they are;
 * - the options form is checked like the base class checks it: an empty append returns no envelopes, pre-built
 *   envelopes have to continue the stream, `ExpectedVersion.Any` and append metadata throw an
 *   `UnsupportedOperationException`, and `publish: false` skips the publisher. The events mixed with pre-built
 *   envelopes are passed on as envelopes with the version of their index, since the 3.x stores number the events
 *   without counting the envelopes;
 * - in both forms, pre-built envelopes may carry no headers and no `eventVersion`, which such a store would drop
 *   (`UnsupportedOperationException`), and are passed on without their `globalPosition`.
 * @internal
 */
export const createLegacyEventStoreProxy = <T extends EventStore<unknown>>(
	store: T,
	{ eventMap, publisher, logger }: { eventMap: EventMap; publisher: EnvelopePublisher; logger: Logger },
): T => {
	const component = `${store.constructor.name} (a store that overrides appendEvents)`;
	const nextEventId = EventId.factory();

	/**
	 * A pre-built envelope without the fields that a 3.x store can't store, or would store without reading them back.
	 */
	const storable = (envelope: EventEnvelope): EventEnvelope => {
		const {
			globalPosition: _position,
			headers: _headers,
			eventVersion: _eventVersion,
			...metadata
		} = envelope.metadata;
		return EventEnvelope.from(envelope.event, envelope.payload, metadata);
	};

	/**
	 * The items of an append in the options form: as they are without pre-built envelopes; otherwise every item as an
	 * envelope, the events with the version of their index.
	 */
	const legacyItems = (stream: EventStream, items: readonly AppendItem[], expectedVersion: number): AppendItem[] => {
		if (!items.some((item) => item instanceof EventEnvelope)) {
			return [...items];
		}
		return items.map((item, index) =>
			item instanceof EventEnvelope
				? storable(item)
				: EventEnvelope.create(eventMap.getName(item), eventMap.serializeEvent(item), {
						aggregateId: stream.aggregateId,
						version: expectedVersion + 1 + index,
						eventId: nextEventId(),
					}),
		);
	};

	/**
	 * The arguments to call the store's own `appendEvents` with, or undefined for an empty append in the options form.
	 */
	const forward = (args: unknown[]): { args: unknown[]; publish: boolean } | undefined => {
		const [stream, ...rest] = args;
		const append = normalizeAppendArguments(rest);
		validateAppendMetadata(append.metadata, NO_HEADERS, { component });
		if (append.items.length === 0) {
			// The positional form reaches the store, as in 3.x
			return append.positional ? { args, publish: true } : undefined;
		}

		if (!append.positional) {
			validatePrebuiltEnvelopes(stream as EventStream, append.items, append.expectedVersion);
		}
		for (const item of append.items) {
			if (item instanceof EventEnvelope) {
				const { correlationId, causationId, headers, eventVersion } = item.metadata;
				validateAppendMetadata({ correlationId, causationId, headers }, NO_HEADERS, {
					allowReservedKeys: true,
					component,
				});
				if (eventVersion !== undefined && eventVersion !== null) {
					throw new UnsupportedOperationException({ operation: 'eventVersion', component });
				}
			}
		}
		if (append.positional) {
			const items = append.items.map((item) => (item instanceof EventEnvelope ? storable(item) : item));
			return {
				args: [stream, (append.expectedVersion as number) + append.items.length, items, append.pool],
				publish: true,
			};
		}

		if (append.expectedVersion === ExpectedVersion.Any) {
			throw new UnsupportedOperationException({ operation: 'ExpectedVersion.Any', component });
		}
		const { correlationId, causationId } = (append.metadata ?? {}) as Record<string, unknown>;
		if (
			(correlationId !== undefined && correlationId !== null) ||
			(causationId !== undefined && causationId !== null)
		) {
			throw new UnsupportedOperationException({ operation: 'append metadata', component });
		}
		return {
			args: [
				stream,
				append.expectedVersion + append.items.length,
				legacyItems(stream as EventStream, append.items, append.expectedVersion),
				append.pool,
			],
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
