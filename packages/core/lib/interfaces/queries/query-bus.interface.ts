import type { ResultOf } from '../../models/message.js';
import type { IQuery } from './query.interface.js';

export interface IQueryBus<QueryBase extends IQuery = IQuery> {
	execute<TQuery extends QueryBase, TResult = ResultOf<TQuery>>(
		query: TQuery,
		options?: { request?: unknown },
	): Promise<NoInfer<TResult>>;
}
