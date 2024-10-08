import { Injectable } from '@nestjs/common';
import 'reflect-metadata';
import { MissingQueryMetadataException, QueryHandlerNotFoundException } from './exceptions';
import { DefaultQueryPubSub, ObservableBus, getQueryMetadata } from './helpers';
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
}
