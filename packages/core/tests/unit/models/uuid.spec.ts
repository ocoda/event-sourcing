import { InvalidIdException, UUID } from '@ocoda/event-sourcing';

describe(UUID, () => {
	it('should generate a UUID', () => {
		const generatedUUID = UUID.generate();
		expect(generatedUUID.value).toBeDefined();
	});

	it('should create a UUID from an existing value', () => {
		const value = 'b6bca415-b7a6-499c-9f39-bf8fbf980a82';
		const createdUUID = UUID.from(value);
		expect(createdUUID.value).toBe(value);
	});

	it('should throw when trying to create a UUID from an undefined variable', () => {
		const value = undefined as unknown as string;
		expect(() => UUID.from(value)).toThrow(new InvalidIdException({ value, idType: 'UUID' }));
	});

	it('should throw when creating a UUID from an invalid value', () => {
		const generatedUUID = UUID.generate();
		expect(generatedUUID.value).toBeDefined();

		const value = '123-abc';
		expect(() => UUID.from(value)).toThrow(new InvalidIdException({ value, idType: 'UUID' }));
	});

	it('should throw an InvalidIdException when from() is called detached', () => {
		class AccountId extends UUID {}

		expect(() => [''].map(UUID.from)).toThrow(InvalidIdException);
		// idType names the id class that rejected the value, for an empty and a malformed value alike
		expect(() => [''].map(AccountId.from)).toThrow(new InvalidIdException({ value: '', idType: 'UUID' }));
		expect(() => AccountId.from('123-abc')).toThrow(new InvalidIdException({ value: '123-abc', idType: 'UUID' }));
	});
});
