import { InvalidIdException, ULID } from '@ocoda/event-sourcing';

describe(ULID, () => {
	it('should generate a ULID', () => {
		const generatedUlid = ULID.generate();
		expect(generatedUlid.value).toBeDefined();
	});

	it('should return date information', () => {
		const generatedUlid = ULID.from('01JAD3JSA97C385R2GKERK1VK7');
		expect(generatedUlid.time).toBe(1729164305737);
		expect(generatedUlid.date).toEqual(new Date(1729164305737));
		expect(generatedUlid.yearMonth).toBe('2024-10');
	});

	it('should create a ULID from an existing value', () => {
		const ulid = '01JA50F56AM0CCDBNVQW3TTWNY';
		const createdULID = ULID.from(ulid);
		expect(createdULID.value).toBe(ulid);
		expect(createdULID.time).toBe(1728892605642);
		expect(createdULID.date).toEqual(new Date(1728892605642));
	});

	it('should throw when trying to create a ULID from an undefined variable', () => {
		let value: string;
		expect(() => ULID.from(value)).toThrow(InvalidIdException.becauseEmpty());
	});

	it('should throw when creating a ULID from an invalid value', () => {
		const generatedULID = ULID.generate();
		expect(generatedULID.value).toBeDefined();

		const value = '123-abc';
		expect(() => ULID.from(value)).toThrow(InvalidIdException.becauseInvalid(value));
	});

	it("should generate different ULID's for different instances", () => {
		const generatedUlid1 = ULID.generate();
		const generatedUlid2 = ULID.generate();
		expect(generatedUlid1.value).not.toBe(generatedUlid2.value);
	});

	it("should guarantee different ULID's for the same seed date when using the factory", () => {
		const ulidFactory = ULID.factory();
		const dateSeed = new Date();

		const generatedUlid1 = ulidFactory(dateSeed);
		const generatedUlid2 = ulidFactory(dateSeed);
		expect(generatedUlid1.value).not.toBe(generatedUlid2.value);
	});
});
