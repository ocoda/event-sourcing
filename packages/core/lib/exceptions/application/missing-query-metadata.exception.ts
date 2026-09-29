import type { Type } from '@nestjs/common';
import type { IQuery } from '../../interfaces/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when a query class has no metadata, which `@QueryHandler()` assigns: no handler was ever declared for it.
 */
export class MissingQueryMetadataException extends EventSourcingError {
	override readonly name = 'MissingQueryMetadataException';
	readonly code = EventSourcingErrorCode.MissingQueryMetadata;
	/** The class name of the query. */
	readonly queryName?: string;

	constructor(details: { query: IQuery | Type<IQuery> | string }, options?: ErrorOptions) {
		const queryName = nameOf(details?.query);
		super(`Missing query metadata exception for ${queryName ?? 'unknown'}`, options);
		this.queryName = queryName;
	}
}
