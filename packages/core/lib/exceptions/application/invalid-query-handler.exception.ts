import type { IQueryHandler } from '@ocoda/event-sourcing/interfaces';

export class InvalidQueryHandlerException extends Error {
	constructor(queryHandler: IQueryHandler) {
		super(
			`Invalid query handler instance provided. Expected an instance of IQueryHandler, but got ${queryHandler.constructor.name}.`,
		);
	}
}
