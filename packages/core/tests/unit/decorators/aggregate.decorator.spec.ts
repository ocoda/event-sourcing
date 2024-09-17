import { AGGREGATE_METADATA, Aggregate, AggregateMetadata, AggregateRoot } from '@ocoda/event-sourcing';

describe('@Aggregate', () => {
	it('should add aggregate metadata to the aggregate', () => {
		@Aggregate({ streamName: 'account' })
		class Account extends AggregateRoot {}

		const { streamName }: AggregateMetadata = Reflect.getMetadata(AGGREGATE_METADATA, Account);
		expect(streamName).toEqual('account');
	});

	it('should provide default aggregate metadata to the aggregate', () => {
		@Aggregate()
		class Account extends AggregateRoot {}

		const { streamName }: AggregateMetadata = Reflect.getMetadata(AGGREGATE_METADATA, Account);

		expect(streamName).toEqual('account');
	});
});
