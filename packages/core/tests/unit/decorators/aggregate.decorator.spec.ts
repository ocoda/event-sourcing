import {
	AGGREGATE_METADATA,
	Aggregate,
	type AggregateMetadata,
	AggregateRoot,
	InvalidAggregateStreamNameError,
} from '@ocoda/event-sourcing';

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

	it('should throw when an aggregate name exceeds 50 characters', () => {
		const decorate = (length: number) => {
			@Aggregate({ streamName: 'a'.repeat(length) })
			class Account extends AggregateRoot {}
		};

		expect(() => decorate(50)).not.toThrow();
		expect(() => decorate(51)).toThrow(InvalidAggregateStreamNameError.becauseExceedsMaxLength('Account', 50));
	});
});
