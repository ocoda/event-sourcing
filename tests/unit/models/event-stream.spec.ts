import { Aggregate, AggregateRoot, EventStream, Id, MissingAggregateMetadataException } from '../../../lib';

describe(EventStream, () => {
	@Aggregate({ eventStream: 'account'})
	class Account extends AggregateRoot {}
	class AccountId extends Id {}

	it('should create an EventStream from an Aggregate class', () => {
		const accountId = AccountId.generate();
		const eventStream = EventStream.for(Account, accountId);

		expect(eventStream.subject).toBe(`account-${accountId.value}`);
		expect(eventStream.collection).toBe('events');
		expect(eventStream.pool).toBe('default');
	});

	it('should create an EventStream from an Aggregate instance', () => {
		const account = new Account();
		const accountId = AccountId.generate();
		const eventStream = EventStream.for(account, accountId);

		expect(eventStream.subject).toBe(`account-${accountId.value}`);
		expect(eventStream.collection).toBe('events');
		expect(eventStream.pool).toBe('default');
	});

	it('should throw when creating an event-stream for an undecorated aggregate', () => {
		class FooId extends Id {}
		class Foo extends AggregateRoot {}

		expect(() => EventStream.for(Foo, FooId.generate())).toThrow(new MissingAggregateMetadataException(Foo));
	});
});
