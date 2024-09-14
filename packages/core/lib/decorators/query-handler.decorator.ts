import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import { IQuery } from '../interfaces';
import { QUERY_HANDLER_METADATA, QUERY_METADATA } from './constants';

/**
 * Decorator that marks a class as a query handler. A query handler
 * handles queries executed by your application code.
 *
 * The decorated class must implement the `IQueryHandler` interface.
 *
 * The handler automatically assigns an id to the query metadata.
 *
 * @param query query *type* to be handled by this handler.
 */
export const QueryHandler = (query: IQuery): ClassDecorator => {
	return (target: object) => {
		if (!Reflect.hasMetadata(QUERY_METADATA, query)) {
			Reflect.defineMetadata(QUERY_METADATA, { id: randomUUID() }, query);
		}
		Reflect.defineMetadata(QUERY_HANDLER_METADATA, { query }, target);
	};
};
