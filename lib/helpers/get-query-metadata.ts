import { QUERY_METADATA } from '../decorators';
import { MissingQueryMetadataException } from '../exceptions';
import { QueryMetadata } from '../interfaces';
import { QueryHandlerType } from '../query-bus';

export const getQueryMetadata = (query: QueryHandlerType): QueryMetadata => {
	const metadata = Reflect.getMetadata(QUERY_METADATA, query);
	if (!metadata) {
		throw new MissingQueryMetadataException(query);
	}
	return metadata;
};
