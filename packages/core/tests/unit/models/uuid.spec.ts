import { InvalidIdException, UUID } from '@ocoda/event-sourcing';

describe(UUID, () => {
	// The brands keep the classes apart for the type assertions: without members of their own they equal UUID
	class AccountId extends UUID {
		declare private readonly brand: 'AccountId';
	}
	class CustomerId extends UUID {
		declare private readonly brand: 'CustomerId';
	}

	it('should generate a UUID', () => {
		const generatedUUID = UUID.generate();
		expect(generatedUUID.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(generatedUUID).toBeInstanceOf(UUID);
	});

	it('should generate an id of the class it is called on', () => {
		const accountId = AccountId.generate();

		expect(accountId).toBeInstanceOf(AccountId);
		expect(accountId).not.toBeInstanceOf(CustomerId);
		expectTypeOf(accountId).toEqualTypeOf<AccountId>();
		expectTypeOf(accountId).not.toEqualTypeOf<UUID>();
		expectTypeOf(AccountId.from(accountId.value)).toEqualTypeOf<AccountId>();
		expectTypeOf(AccountId.from(accountId.value)).not.toEqualTypeOf<UUID>();
		expectTypeOf(UUID.generate()).toEqualTypeOf<UUID>();
		expectTypeOf(UUID.generate()).not.toEqualTypeOf<AccountId>();
	});

	it('should create a UUID from an existing value', () => {
		const value = 'b6bca415-b7a6-499c-9f39-bf8fbf980a82';
		const createdUUID = UUID.from(value);
		expect(createdUUID.value).toBe(value);
		expect(UUID.from(value.toUpperCase()).value).toBe(value.toUpperCase());
		expect(AccountId.from(value)).toBeInstanceOf(AccountId);
	});

	it('should tell ids of different classes apart, even with the same value', () => {
		const value = 'b6bca415-b7a6-499c-9f39-bf8fbf980a82';

		expect(AccountId.from(value).equals(AccountId.from(value))).toBe(true);
		expect(AccountId.from(value).equals(CustomerId.from(value))).toBe(false);
		expect(AccountId.from(value).equals(UUID.from(value))).toBe(false);
		expect(AccountId.from(value).equals(AccountId.generate())).toBe(false);
	});

	it('should throw when trying to create a UUID from an undefined variable', () => {
		const value = undefined as unknown as string;
		expect(() => UUID.from(value)).toThrow(new InvalidIdException({ value, idType: 'UUID' }));
	});

	it.each([
		['not a UUID', '123-abc'],
		['a UUID without its dashes', 'b6bca415b7a6499c9f39bf8fbf980a82'],
		['a UUID in braces', '{b6bca415-b7a6-499c-9f39-bf8fbf980a82}'],
		['a UUID with a trailing newline', 'b6bca415-b7a6-499c-9f39-bf8fbf980a82\n'],
		['a UUID with a non-hexadecimal digit', 'g6bca415-b7a6-499c-9f39-bf8fbf980a82'],
	])('should throw when creating a UUID from %s', (_, value) => {
		expect(() => UUID.from(value)).toThrow(new InvalidIdException({ value, idType: 'UUID' }));
	});

	it('should name the id class that rejected the value', () => {
		expect(() => AccountId.from('123-abc')).toThrow(new InvalidIdException({ value: '123-abc', idType: 'AccountId' }));
		expect(() => AccountId.from('')).toThrow(new InvalidIdException({ value: '', idType: 'AccountId' }));
	});

	it('should keep the class when from() is called detached', () => {
		const value = 'b6bca415-b7a6-499c-9f39-bf8fbf980a82';

		expect(() => [''].map(UUID.from)).toThrow(new InvalidIdException({ value: '', idType: 'UUID' }));
		expect(() => ['123-abc'].map(AccountId.from)).toThrow(
			new InvalidIdException({ value: '123-abc', idType: 'AccountId' }),
		);

		const [accountId] = [value].map(AccountId.from);
		expect(accountId).toBeInstanceOf(AccountId);
		expect(accountId.equals(AccountId.from(value))).toBe(true);
		expect([value].map(UUID.from)[0]).not.toBeInstanceOf(AccountId);
	});
});
