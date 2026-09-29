import type { ResultOf } from '../../models/message.js';
import type { IQuery } from './query.interface.js';

/**
 * Handles one query class. `TResult` defaults to the result type of a `Query<TResult>`, and to `any` for a plain
 * query class.
 */
export interface IQueryHandler<TQuery extends IQuery = any, TResult = ResultOf<TQuery>> {
	execute(query: TQuery): Promise<TResult>;
}
