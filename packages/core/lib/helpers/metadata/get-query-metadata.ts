import { Type } from '@nestjs/common';
import { QUERY_METADATA } from '../../decorators';
import { IQuery, QueryMetadata } from '../../interfaces';

export const getQueryMetadata = (query: Type<IQuery>): QueryMetadata => {
	return Reflect.getMetadata(QUERY_METADATA, query) ?? {};
};
