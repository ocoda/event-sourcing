import type { Type } from '@nestjs/common';
import { QUERY_METADATA } from '../../decorators/index.js';
import type { IQuery, QueryMetadata } from '../../interfaces/index.js';

/**
 * @deprecated The `QueryBus` keys its handlers by class and no longer reads this metadata. Removed in 5.0.
 */
export const getQueryMetadata = (query: Type<IQuery>): QueryMetadata => {
	return Reflect.getMetadata(QUERY_METADATA, query) ?? {};
};
