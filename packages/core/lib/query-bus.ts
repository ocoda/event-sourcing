import 'reflect-metadata';
import { Injectable, type Type } from '@nestjs/common';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';

import {
	MissingQueryHandlerMetadataException,
	MissingQueryMetadataException,
	QueryHandlerNotFoundException,
} from './exceptions';
import { DefaultQueryPubSub, ObservableBus, getQueryHandlerMetadata, getQueryMetadata } from './helpers';
import type { IQuery, IQueryBus, IQueryHandler, IQueryPublisher } from './interfaces';

@Injectable()
export class QueryBus<QueryBase extends IQuery = IQuery>
	extends ObservableBus<QueryBase>
	implements IQueryBus<QueryBase>
{
	private handlers = new Map<string, IQueryHandler<QueryBase>>();
	private _publisher: IQueryPublisher<QueryBase> = new DefaultQueryPubSub<QueryBase>(this.subject$);

	get publisher(): IQueryPublisher<QueryBase> {
		return this._publisher;
	}

	set publisher(_publisher: IQueryPublisher<QueryBase>) {
		this._publisher = _publisher;
	}

	execute<T extends QueryBase, R = any>(query: T): Promise<R> {
		const queryId = this.getQueryId(query);
		const handler = this.handlers.get(queryId);
		if (!handler) {
			const { constructor: queryType } = Object.getPrototypeOf(query);
			throw new QueryHandlerNotFoundException(queryType);
		}
		this._publisher.publish(query);
		return handler.execute(query);
	}

	bind<T extends QueryBase>(handler: IQueryHandler<T>, id: string) {
		this.handlers.set(id, handler);
	}

	private getQueryId(query: QueryBase): string {
		const { constructor: queryType } = Object.getPrototypeOf(query);
		const { id } = getQueryMetadata(queryType);

		if (!id) {
			throw new MissingQueryMetadataException(queryType);
		}

		return id;
	}

	// region registration
	register(handlers: InstanceWrapper<IQueryHandler>[] = []) {
		for (const handler of handlers) {
			this.registerHandler(handler);
		}
	}
	protected registerHandler(handler: InstanceWrapper<IQueryHandler>) {
		const { metatype, instance } = handler;

		// check
		if (!metatype || !instance) {
			throw new Error('Invalid query handler instance provided.');
		}

		// check if the handler is a query handler
		const { query } = getQueryHandlerMetadata(metatype as Type<IQueryHandler>);

		// if not, throw an error
		if (!query) {
			throw new MissingQueryHandlerMetadataException(metatype);
		}

		// get the query id
		const { id } = getQueryMetadata(query);

		// if the query id is not defined, throw an error
		if (!id) {
			throw new MissingQueryMetadataException(query);
		}

		// bind the handler to the query id
		this.bind(instance as IQueryHandler, id);
	}
	// endregion
}
