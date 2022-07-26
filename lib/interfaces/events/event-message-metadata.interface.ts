import { OnEventOptions } from '@nestjs/event-emitter/dist/interfaces';
import { IEvent } from './event.interface';

/**
 * `EventMessage` metadata
 */
export interface EventMessageMetadata {
  /**
   * Aggregate id the message belongs to.
   */
  aggregateId: string;
  /**
   * Version of the aggregate.
   */
  aggregateVersion: number;
  /**
   * Time at which the event ocurred.
   */
  occurredOn: number;
}
