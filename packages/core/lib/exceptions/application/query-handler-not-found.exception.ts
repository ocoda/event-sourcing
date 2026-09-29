import type { Type } from '@nestjs/common';
import type { IQuery } from '../../interfaces/index.js';
import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';
import { nameOf } from '../internal.js';

/**
 * Thrown when a query is executed that has no registered handler.
 */
export class QueryHandlerNotFoundException extends EventSourcingError {
	override readonly name = 'QueryHandlerNotFoundException';
	readonly code = EventSourcingErrorCode.QueryHandlerNotFound;
	/** The class name of the query. */
	readonly queryName?: string;

	constructor(details: { query: IQuery | Type<IQuery> | string }, options?: ErrorOptions) {
		const queryName = nameOf(details?.query);
		super(`The query handler for the "${queryName ?? 'unknown'}" query was not found.`, options);
		this.queryName = queryName;
	}
}
