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
		let value: string;
		expect(() => UUID.from(value)).toThrow(InvalidIdException.becauseEmpty());
	});

	it('should throw when creating a UUID from an invalid value', () => {
		const generatedUUID = UUID.generate();
		expect(generatedUUID.value).toBeDefined();

		const value = '123-abc';
		expect(() => UUID.from(value)).toThrow(InvalidIdException.becauseInvalid(value));
	});
});
