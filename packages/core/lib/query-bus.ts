import 'reflect-metadata';
import { Injectable, type Type } from '@nestjs/common';

import {
	InvalidQueryHandlerException,
	MissingQueryHandlerMetadataException,
	QueryHandlerNotFoundException,
} from './exceptions/index.js';
import { DefaultQueryPubSub, ObservableBus, getQueryHandlerMetadata } from './helpers/index.js';
import type { IQuery, IQueryBus, IQueryHandler, IQueryPublisher, ProviderWrapper } from './interfaces/index.js';
import type { ResultOf } from './models/index.js';

/** The class of a query; `undefined` for `null`, `undefined` and null-prototype objects. */
const classOf = (message: unknown): Function | undefined =>
	message === null || message === undefined ? undefined : Object.getPrototypeOf(message)?.constructor;

@Injectable()
export class QueryBus<QueryBase extends IQuery = IQuery>
	extends ObservableBus<QueryBase>
	implements IQueryBus<QueryBase>
{
	// Keyed by the query class itself, not by metadata on it: a subclass needs its own handler.
	private readonly handlers = new Map<Function, IQueryHandler<any, unknown>>();
	private _publisher: IQueryPublisher<QueryBase> = new DefaultQueryPubSub<QueryBase>(this.subject$);

	get publisher(): IQueryPublisher<QueryBase> {
		return this._publisher;
	}

	set publisher(_publisher: IQueryPublisher<QueryBase>) {
		this._publisher = _publisher;
	}

	/**
	 * Executes a query with the handler registered for its class, and resolves to what the handler resolves to.
	 *
	 * The result type is inferred from a `Query<TResult>`; for a plain query class it is `any`, or the second type
	 * argument: `execute<GetAccountsQuery, Account[]>(query)`.
	 *
	 * @param options Reserved for request-scoped handlers, which a later 4.0 prerelease resolves per request. Until
	 * then it is ignored.
	 * @throws {QueryHandlerNotFoundException} (as a rejection) when no handler is registered for the query's class.
	 * Nothing is published then.
	 */
	async execute<TQuery extends QueryBase, TResult = ResultOf<TQuery>>(
		query: TQuery,
		options?: { request?: unknown },
	): Promise<NoInfer<TResult>> {
		const queryType = classOf(query);
		const handler = queryType && this.handlers.get(queryType);
		if (!handler) {
			throw new QueryHandlerNotFoundException({ query: queryType ?? query });
		}
		this._publisher.publish(query);
		return (await handler.execute(query)) as NoInfer<TResult>;
	}

	/**
	 * Routes the instances of `query` to `handler`, replacing a handler registered for it before.
	 */
	bind<TQuery extends QueryBase>(handler: IQueryHandler<TQuery, unknown>, query: Type<TQuery>) {
		this.handlers.set(query, handler);
	}

	register(handlers: ProviderWrapper<IQueryHandler>[] = []) {
		for (const handler of handlers) {
			this.registerHandler(handler);
		}
	}
	protected registerHandler(handler: ProviderWrapper<IQueryHandler>) {
		const { metatype, instance } = handler;

		// check
		if (!metatype || !instance) {
			throw new InvalidQueryHandlerException({ handler: instance });
		}

		// get the query the handler handles
		const { query } = getQueryHandlerMetadata(metatype as Type<IQueryHandler>);

		// if there is none, the class is not a query handler
		if (typeof query !== 'function') {
			throw new MissingQueryHandlerMetadataException({ handler: metatype });
		}

		// bind the handler to the query class
		this.bind(instance, query as Type<QueryBase>);
	}
}
