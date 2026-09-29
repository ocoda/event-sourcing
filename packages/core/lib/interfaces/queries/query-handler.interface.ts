import type { IQuery } from './query.interface.js';

export interface IQueryHandler<T extends IQuery = any, TRes = any> {
	execute(query: T): Promise<TRes>;
}
