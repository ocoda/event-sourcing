import { EventId, InvalidIdException } from '@ocoda/event-sourcing';

describe(EventId, () => {
	it('should generate an EventId', () => {
		const generatedEventId = EventId.generate();
		expect(generatedEventId.value).toBeDefined();
		expect(generatedEventId).toBeInstanceOf(EventId);
		expect(EventId.factory()()).toBeInstanceOf(EventId);
		expectTypeOf(generatedEventId).toEqualTypeOf<EventId>();
		expectTypeOf(EventId.factory()).returns.toEqualTypeOf<EventId>();
		expectTypeOf(EventId.from(generatedEventId.value)).toEqualTypeOf<EventId>();
	});

	it('should create an EventId from an existing value', () => {
		const value = '01JA50F56AM0CCDBNVQW3TTWNY';
		const createdEventId = EventId.from(value);
		expect(createdEventId.value).toBe(value);
		expect(createdEventId.time).toBe(1728892605642);
		expect(createdEventId.date).toEqual(new Date(1728892605642));
	});

	it('should throw when trying to create an EventId from an undefined variable', () => {
		const value = undefined as unknown as string;
		expect(() => EventId.from(value)).toThrow(new InvalidIdException({ value, idType: 'EventId' }));
	});

	it('should throw when creating an EventId from an invalid value', () => {
		const generatedEventId = EventId.generate();
		expect(generatedEventId.value).toBeDefined();

		const value = '123-abc';
		expect(() => EventId.from(value)).toThrow(new InvalidIdException({ value, idType: 'EventId' }));
	});

	it('should throw an InvalidIdException when from() is called detached', () => {
		expect(() => [''].map(EventId.from)).toThrow(new InvalidIdException({ value: '', idType: 'EventId' }));
	});

	it("should generate different EventId's for different instances", () => {
		const generatedEventId1 = EventId.generate();
		const generatedEventId2 = EventId.generate();
		expect(generatedEventId1.value).not.toBe(generatedEventId2.value);
	});

	describe('fromTrusted', () => {
		it('wraps a stored id like from() does', () => {
			const value = '01JA50F56AM0CCDBNVQW3TTWNY';
			const trusted = EventId.fromTrusted(value);

			expect(trusted).toBeInstanceOf(EventId);
			expect(trusted).toStrictEqual(EventId.from(value));
			expect(trusted.equals(EventId.from(value))).toBe(true);
			expect(EventId.from(value).equals(trusted)).toBe(true);
			expect(trusted.value).toBe(value);
			expect(trusted.time).toBe(1728892605642);
			expect(trusted.date).toEqual(new Date(1728892605642));
			expect(Object.isFrozen(trusted.props)).toBe(true);
		});

		it('does not validate, so ids that from() rejects stay readable', () => {
			// The last one is a 3.x id that is not Crockford base32: 3.x accepted any 26 letters and numbers
			for (const value of [
				'123-abc',
				'not a ulid',
				'01ja50f56am0ccdbnvqw3ttwny-legacy',
				'01JA50F56AM0CCDBNVQW3TILOU',
			]) {
				expect(() => EventId.from(value)).toThrow(InvalidIdException);
				expect(EventId.fromTrusted(value).value).toBe(value);
			}
		});

		it('works when called detached', () => {
			expect(['01JA50F56AM0CCDBNVQW3TTWNY'].map(EventId.fromTrusted)[0]).toBeInstanceOf(EventId);
		});
	});

	it("should guarantee different EventId's for the same seed date when using the factory", () => {
		const ulidFactory = EventId.factory();
		const dateSeed = new Date();

		const generatedEventId1 = ulidFactory(dateSeed);
		const generatedEventId2 = ulidFactory(dateSeed);
		expect(generatedEventId1.value).not.toBe(generatedEventId2.value);
	});
});
