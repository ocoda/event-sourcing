import { EventId, InvalidIdException } from '@ocoda/event-sourcing';

describe(EventId, () => {
	it('should generate an EventId', () => {
		const generatedEventId = EventId.generate();
		expect(generatedEventId.value).toBeDefined();
	});

	it('should create an EventId from an existing value', () => {
		const value = '01JA50F56AM0CCDBNVQW3TTWNY';
		const createdEventId = EventId.from(value);
		expect(createdEventId.value).toBe(value);
		expect(createdEventId.time).toBe(1728892605642);
		expect(createdEventId.date).toEqual(new Date(1728892605642));
	});

	it('should throw when trying to create an EventId from an undefined variable', () => {
		let value: string;
		expect(() => EventId.from(value)).toThrow(InvalidIdException.becauseEmpty());
	});

	it('should throw when creating an EventId from an invalid value', () => {
		const generatedEventId = EventId.generate();
		expect(generatedEventId.value).toBeDefined();

		const value = '123-abc';
		expect(() => EventId.from(value)).toThrow(InvalidIdException.becauseInvalid(value));
	});

	it("should generate different EventId's for different instances", () => {
		const generatedEventId1 = EventId.generate();
		const generatedEventId2 = EventId.generate();
		expect(generatedEventId1.value).not.toBe(generatedEventId2.value);
	});

	it("should guarantee different EventId's for the same seed date when using the factory", () => {
		const ulidFactory = EventId.factory();
		const dateSeed = new Date();

		const generatedEventId1 = ulidFactory(dateSeed);
		const generatedEventId2 = ulidFactory(dateSeed);
		expect(generatedEventId1.value).not.toBe(generatedEventId2.value);
	});
});
