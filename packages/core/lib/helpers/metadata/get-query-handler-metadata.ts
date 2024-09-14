import { Type } from '@nestjs/common';
import { QUERY_HANDLER_METADATA } from '../../decorators';
import { IQueryHandler, QueryHandlerMetadata } from '../../interfaces';

export const getQueryHandlerMetadata = (queryHandler: Type<IQueryHandler>): QueryHandlerMetadata => {
	return Reflect.getMetadata(QUERY_HANDLER_METADATA, queryHandler) ?? {};
};
