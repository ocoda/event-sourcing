import 'reflect-metadata';
import { Inject, Injectable, Optional, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import {
	InvalidQueryHandlerException,
	MissingQueryHandlerMetadataException,
	QueryHandlerNotFoundException,
} from './exceptions/index.js';
import { DefaultQueryPubSub, ObservableBus, getQueryHandlerMetadata } from './helpers/index.js';
import { classOf, handlerFor } from './helpers/message-handlers.js';
import type { IQuery, IQueryBus, IQueryHandler, IQueryPublisher, ProviderWrapper } from './interfaces/index.js';
import type { ResultOf } from './models/index.js';
import { isStaticProvider, providerClassOf } from './registration/providers.js';
import { EVENT_SOURCING_REGISTRATION, type Registration } from './registration/registration.js';
import { ScopedHandler } from './registration/scoped-handler.js';

@Injectable()
export class QueryBus<QueryBase extends IQuery = IQuery>
	extends ObservableBus<QueryBase>
	implements IQueryBus<QueryBase>
{
	// Keyed by the query class itself, not by an id stored on it, which a subclass would inherit.
	private readonly handlers = new Map<Function, IQueryHandler<any, unknown> | ScopedHandler<IQueryHandler>>();
	private _publisher: IQueryPublisher<QueryBase> = new DefaultQueryPubSub<QueryBase>(this.subject$);

	/**
	 * @param moduleRef In the `EventSourcingModule`: resolves the handlers that are not singletons, per call.
	 * @param registration In the `EventSourcingModule`: registers the handlers on the first `execute`, if the module
	 * hasn't yet.
	 */
	constructor(
		@Optional() private readonly moduleRef?: ModuleRef,
		@Optional() @Inject(EVENT_SOURCING_REGISTRATION) private readonly registration?: Registration,
	) {
		super();
	}

	get publisher(): IQueryPublisher<QueryBase> {
		return this._publisher;
	}

	set publisher(_publisher: IQueryPublisher<QueryBase>) {
		this._publisher = _publisher;
	}

	/**
	 * Executes a query with the handler registered for its class, or for its nearest parent class that has one, and
	 * resolves to what the handler resolves to.
	 *
	 * The result type is inferred from a `Query<TResult>`; for a plain query class it is `any`, or the second type
	 * argument: `execute<GetAccountsQuery, Account[]>(query)`.
	 *
	 * A handler that is not a singleton (request-scoped, transient, or depending on a request-scoped provider) is
	 * resolved for every call: in the DI context of `options.request`, which it can inject with `@Inject(REQUEST)`, or,
	 * without a request, in a new context, so every call gets a new instance.
	 *
	 * @param options.request The request the query is executed for, such as the request object of a controller.
	 * @throws {QueryHandlerNotFoundException} (as a rejection) when no handler is registered for the query's class
	 * or any of its parent classes. Nothing is published then.
	 * @throws {EventSourcingNotReadyException} (as a rejection) when called while Nest is still instantiating the
	 * providers, from a provider factory or constructor.
	 */
	async execute<TQuery extends QueryBase, TResult = ResultOf<TQuery>>(
		query: TQuery,
		options?: { request?: unknown },
	): Promise<NoInfer<TResult>> {
		this.registration?.ensureRegistered('QueryBus.execute');
		const queryType = classOf(query);
		const binding = handlerFor(this.handlers, queryType);
		if (!binding) {
			throw new QueryHandlerNotFoundException({ query: queryType ?? query });
		}
		const handler = binding instanceof ScopedHandler ? await binding.resolve(options?.request) : binding;
		this._publisher.publish(query);
		return (await handler.execute(query)) as NoInfer<TResult>;
	}

	/**
	 * Routes the instances of `query`, and of its subclasses without a handler of their own, to `handler`, replacing a
	 * handler registered for it before.
	 */
	bind<TQuery extends QueryBase>(handler: IQueryHandler<TQuery>, query: Type<TQuery>) {
		this.handlers.set(query, handler);
	}

	register(handlers: ProviderWrapper<IQueryHandler>[] = []) {
		for (const handler of handlers) {
			this.registerHandler(handler);
		}
	}
	/**
	 * Registers a handler as Nest's discovery lists it. The metadata is read from the class of its instance, so that
	 * factory and value providers work. A singleton is bound as it is; any other handler is resolved per call.
	 */
	protected registerHandler(handler: ProviderWrapper<IQueryHandler>) {
		const type = providerClassOf(handler);
		const isStatic = isStaticProvider(handler);
		if (!type || (isStatic && !handler.instance) || (!isStatic && !this.moduleRef)) {
			throw new InvalidQueryHandlerException({ handler: handler?.instance ?? type });
		}

		// get the query the handler handles
		const { query } = getQueryHandlerMetadata(type as Type<IQueryHandler>);
		if (typeof query !== 'function') {
			throw new MissingQueryHandlerMetadataException({ handler: type });
		}

		if (isStatic) {
			this.bind(handler.instance as IQueryHandler<QueryBase>, query as Type<QueryBase>);
		} else {
			this.handlers.set(query, new ScopedHandler<IQueryHandler>(handler.token, this.moduleRef as ModuleRef));
		}
	}
}
