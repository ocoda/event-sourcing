import type { IEventPublisher } from '../events/index.js';

/**
 * `@Aggregate` decorator metadata
 */
export interface AggregateMetadata {
	/**
	 * The name of the streams for this aggregate.
	 */
	streamName?: string;
	/**
	 * Event publishers
	 */
	publishers?: IEventPublisher[];
}
