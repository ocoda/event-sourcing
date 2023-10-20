import { Aggregate, AggregateRoot, EventStream, MissingAggregateMetadataException, UUID } from '../../../lib';

describe(EventStream, () => {
	@Aggregate({ streamName: 'account' }) class Account extends AggregateRoot {}
	class AccountId extends UUID {}

	it('should create an EventStream from an Aggregate class', () => {
		const accountId = AccountId.generate();
		const eventStream = EventStream.for(Account, accountId);

		expect(eventStream.aggregateId).toBe(accountId.value);
		expect(eventStream.streamId).toBe(`account-${accountId.value}`);
	});

	it('should create an EventStream from an Aggregate instance', () => {
		const account = new Account();
		const accountId = AccountId.generate();
		const eventStream = EventStream.for(account, accountId);

		expect(eventStream.aggregateId).toBe(accountId.value);
		expect(eventStream.streamId).toBe(`account-${accountId.value}`);
	});

	it('should throw when creating an event-stream for an undecorated aggregate', () => {
		class FooId extends UUID {}
		class Foo extends AggregateRoot {}

		expect(() => EventStream.for(Foo, FooId.generate())).toThrow(new MissingAggregateMetadataException(Foo));
	});
});
