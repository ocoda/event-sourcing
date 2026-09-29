import type { IEventPublisher } from '../events/index.js';

/**
 * What an aggregate does with an event it has no `@EventHandler()` for.
 * - `'throw'`: `applyEvent()` throws a `MissingEventHandlerException` and leaves the aggregate unchanged.
 * - `'ignore'`: the event is applied without a handler: it counts towards the version and, unless it comes from the
 *   history, is recorded as uncommitted.
 */
export type MissingEventHandlerPolicy = 'throw' | 'ignore';

/**
 * `@Aggregate` decorator metadata
 */
export interface AggregateMetadata {
	/**
	 * The name of the streams for this aggregate.
	 */
	streamName?: string;
	/**
	 * What `applyEvent()` does with an event the aggregate has no `@EventHandler()` for.
	 * @default 'throw'
	 */
	missingHandler?: MissingEventHandlerPolicy;
	/**
	 * Event publishers
	 */
	publishers?: IEventPublisher[];
}
