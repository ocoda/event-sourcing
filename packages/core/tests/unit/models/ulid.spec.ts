import { InvalidIdException, ULID } from '@ocoda/event-sourcing';

describe(ULID, () => {
	class EventId extends ULID {}

	it('should generate an EventId', () => {
		const generatedEventId = EventId.generate();
		expect(generatedEventId.value).toBeDefined();
	});

	it('should create an EventId from an existing ulid', () => {
		const ulid = '01JA50F56AM0CCDBNVQW3TTWNY';
		const createdEventId = EventId.from(ulid);
		expect(createdEventId.value).toBe(ulid);
		expect(createdEventId.time).toBe(1728892605642);
		expect(createdEventId.date).toEqual(new Date(1728892605642));
	});

	it('should throw when trying to create an id from an undefined variable', () => {
		let ulid: string;
		expect(() => EventId.from(ulid)).toThrow(InvalidIdException.becauseEmpty());
	});

	it('should throw when creating an Id from an invalid ulid', () => {
		const generatedEventId = EventId.generate();
		expect(generatedEventId.value).toBeDefined();

		const ulid = '123-abc';
		expect(() => EventId.from(ulid)).toThrow(InvalidIdException.becauseInvalid(ulid));
	});

	it('should generate different EventIds for different instances', () => {
		const eventId1 = EventId.generate();
		const eventId2 = EventId.generate();
		expect(eventId1.value).not.toBe(eventId2.value);
	});

	it('should guarantee different EventIds for the same seed time when using the factory', () => {
		const eventIdFactory = EventId.factory();
		const seedTime = Date.now();

		const x = eventIdFactory();
		const eventId1 = eventIdFactory(seedTime);
		const eventId2 = eventIdFactory(seedTime);
		expect(eventId1.value).not.toBe(eventId2.value);
	});
});
