import { InvalidIdError, UUID } from '@ocoda/event-sourcing';

describe(UUID, () => {
	class AccountId extends UUID {}

	it('should generate an AccountId', () => {
		const generatedAccountId = AccountId.generate();
		expect(generatedAccountId.value).toBeDefined();
	});

	it('should create an AccountId from an existing uuid', () => {
		const uuid = 'b6bca415-b7a6-499c-9f39-bf8fbf980a82';
		const createdAccountId = AccountId.from(uuid);
		expect(createdAccountId.value).toBe(uuid);
	});

	it('should throw when trying to create an id from an undefined variable', () => {
		let uuid: string;
		expect(() => AccountId.from(uuid)).toThrow(InvalidIdError.becauseEmpty());
	});

	it('should throw when creating an Id from an invalid uuid', () => {
		const generatedAccountId = AccountId.generate();
		expect(generatedAccountId.value).toBeDefined();

		const uuid = '123-abc';
		expect(() => AccountId.from(uuid)).toThrow(InvalidIdError.becauseInvalid(uuid));
	});
});
