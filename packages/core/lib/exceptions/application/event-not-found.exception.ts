import type { IEventPool } from '../../interfaces/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * Thrown when a stream has no event at the requested version.
 */
export class EventNotFoundException extends EventSourcingError {
	override readonly name = 'EventNotFoundException';
	readonly code = EventSourcingErrorCode.EventNotFound;
	readonly streamId: string;
	readonly version: number;
	readonly pool?: IEventPool;

	constructor(details: { streamId: string; version: number; pool?: IEventPool }, options?: ErrorOptions) {
		super(
			`Event with version ${details?.version} not found in the ${details?.streamId} stream${details?.pool ? ` of the ${details.pool} pool` : ''}.`,
			options,
		);
		this.streamId = details?.streamId;
		this.version = details?.version;
		this.pool = details?.pool;
	}
}
