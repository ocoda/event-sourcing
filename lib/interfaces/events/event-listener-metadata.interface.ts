import { OnEventOptions } from '@nestjs/event-emitter/dist/interfaces';
import { IEvent } from './event.interface';

/**
 * `@EventListener` decorator metadata
 */
export interface EventListenerMetadata {
	/**
   * Event type to subscribe to.
   */
	event: IEvent;
	/**
   * Subscription options.
   */
	options?: OnEventOptions;
}
