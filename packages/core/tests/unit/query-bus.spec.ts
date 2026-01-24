import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import {
	MissingQueryHandlerMetadataException,
	MissingQueryMetadataException,
	QueryBus,
	QueryHandlerNotFoundException,
} from '@ocoda/event-sourcing';
import { QUERY_HANDLER_METADATA, QUERY_METADATA } from '@ocoda/event-sourcing/decorators';

describe(QueryBus, () => {
	class QueryWithoutMetadata {}
	class QueryWithMetadata {}

	class QueryHandlerWithoutMetadata {
		execute() {
			return 'ok';
		}
	}

	class QueryHandlerWithMetadata {
		execute() {
			return 'ok';
		}
	}

	beforeAll(() => {
		Reflect.defineMetadata(QUERY_METADATA, { id: 'query-with-metadata' }, QueryWithMetadata);
	});

	it('throws when executing a query without handler', () => {
		const bus = new QueryBus();
		class QueryWithMetadataOnly {}
		Reflect.defineMetadata(QUERY_METADATA, { id: 'query-with-handler' }, QueryWithMetadataOnly);
		const query = new (QueryWithMetadataOnly as any)();

		expect(() => bus.execute(query)).toThrow(QueryHandlerNotFoundException);
	});

	it('throws when query metadata is missing', () => {
		const bus = new QueryBus();
		const query = new (QueryWithoutMetadata as any)();

		expect(() => bus.execute(query)).toThrow(MissingQueryMetadataException);
	});

	it('throws when registering a handler without instance', () => {
		const bus = new QueryBus();
		const wrapper = { metatype: QueryHandlerWithMetadata, instance: undefined } as unknown as InstanceWrapper;

		expect(() => bus.register([wrapper])).toThrow(TypeError);
	});

	it('throws when registering a handler without handler metadata', () => {
		const bus = new QueryBus();
		const wrapper = {
			metatype: QueryHandlerWithoutMetadata,
			instance: new QueryHandlerWithoutMetadata(),
		} as unknown as InstanceWrapper;

		expect(() => bus.register([wrapper])).toThrow(MissingQueryHandlerMetadataException);
	});

	it('throws when registering handler for query without metadata', () => {
		const bus = new QueryBus();
		Reflect.defineMetadata(QUERY_HANDLER_METADATA, { query: QueryWithoutMetadata }, QueryHandlerWithMetadata);
		const wrapper = {
			metatype: QueryHandlerWithMetadata,
			instance: new QueryHandlerWithMetadata(),
		} as unknown as InstanceWrapper;

		expect(() => bus.register([wrapper])).toThrow(MissingQueryMetadataException);
	});
});
