import type { Type } from '@nestjs/common';
import { QUERY_METADATA } from '../../decorators/index.js';
import type { IQuery, QueryMetadata } from '../../interfaces/index.js';

export const getQueryMetadata = (query: Type<IQuery>): QueryMetadata => {
	return Reflect.getMetadata(QUERY_METADATA, query) ?? {};
};
