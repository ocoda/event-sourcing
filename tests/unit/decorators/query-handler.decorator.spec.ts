import { IQuery, IQueryHandler, QueryHandler } from '../../../lib';
import { getQueryHandlerMetadata, getQueryMetadata } from '../../../lib/helpers';

describe('@QueryHandler', () => {
	class TestQuery implements IQuery {}

	@QueryHandler(TestQuery)
	class TestQueryHandler implements IQueryHandler {
		async execute() {}
	}

	it('should specify which query the query-handler handles', () => {
		const { query } = getQueryHandlerMetadata(TestQueryHandler);
		expect(query).toEqual(TestQuery);

		const { id } = getQueryMetadata(query);
		expect(id).toBeDefined();
	});
});
