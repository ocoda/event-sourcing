import { QUERY_METADATA } from '../decorators';
import { QueryMetadata } from '../interfaces';
import { QueryType } from '../query-bus';

export const getQueryMetadata = (query: QueryType): QueryMetadata => {
	return Reflect.getMetadata(QUERY_METADATA, query) ?? {};
};
