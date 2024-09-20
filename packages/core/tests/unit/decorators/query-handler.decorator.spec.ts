import { type IQuery, type IQueryHandler, QueryHandler } from '@ocoda/event-sourcing';
import { getQueryHandlerMetadata, getQueryMetadata } from '@ocoda/event-sourcing/helpers';

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
