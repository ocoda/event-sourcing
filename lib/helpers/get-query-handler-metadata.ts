import { QUERY_HANDLER_METADATA } from '../decorators';
import { QueryHandlerMetadata } from '../interfaces';

export const getQueryHandlerMetadata = (queryHandler: Function): QueryHandlerMetadata => {
	return Reflect.getMetadata(QUERY_HANDLER_METADATA, queryHandler) ?? {};
};
