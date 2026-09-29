import { randomUUID } from 'node:crypto';
import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import type { IQuery, IQueryHandler, QueryMetadata } from '../interfaces/index.js';
import { QUERY_HANDLER_METADATA, QUERY_METADATA } from './constants.js';

/**
 * Decorator that marks a class as a query handler. A query handler handles queries executed by your application code.
 * @description The decorated class must implement `IQueryHandler`: its `execute` takes the query and resolves to the
 * query's result type (see `Query<TResult>`). The `QueryBus` routes the instances of exactly this query class to it.
 * @param query The query class handled by this handler.
 * @example `@QueryHandler(GetAccountByIdQuery)`
 */
export const QueryHandler = <TQuery extends IQuery>(
	query: Type<TQuery>,
): ((target: Type<IQueryHandler<TQuery>>) => void) => {
	return (target) => {
		// Kept for 3.x code that reads getQueryMetadata(); the QueryBus keys its handlers by class.
		if (!Reflect.hasMetadata(QUERY_METADATA, query)) {
			Reflect.defineMetadata(QUERY_METADATA, { id: randomUUID() } as QueryMetadata, query);
		}
		Reflect.defineMetadata(QUERY_HANDLER_METADATA, { query }, target);
	};
};
