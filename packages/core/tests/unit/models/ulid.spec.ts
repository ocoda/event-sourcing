import { EventId, InvalidIdException, ULID } from '@ocoda/event-sourcing';

describe(ULID, () => {
	// The brands keep the classes apart for the type assertions: without members of their own they equal ULID
	class OrderId extends ULID {
		declare private readonly brand: 'OrderId';
	}
	class InvoiceId extends ULID {
		declare private readonly brand: 'InvoiceId';
	}

	it('should generate a ULID', () => {
		const generatedUlid = ULID.generate();
		expect(generatedUlid.value).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
		expect(generatedUlid).toBeInstanceOf(ULID);
	});

	it('should return date information', () => {
		const generatedUlid = ULID.from('01JAD3JSA97C385R2GKERK1VK7');
		expect(generatedUlid.time).toBe(1729164305737);
		expect(generatedUlid.date).toEqual(new Date(1729164305737));
	});

	it('should create a ULID from an existing value', () => {
		const ulid = '01JA50F56AM0CCDBNVQW3TTWNY';
		const createdULID = ULID.from(ulid);
		expect(createdULID.value).toBe(ulid);
		expect(createdULID.time).toBe(1728892605642);
		expect(createdULID.date).toEqual(new Date(1728892605642));
	});

	it('should create a ULID from a lower-case value, keeping its case', () => {
		const ulid = '01ja50f56am0ccdbnvqw3ttwny';
		const createdULID = ULID.from(ulid);
		expect(createdULID.value).toBe(ulid);
		expect(createdULID.time).toBe(1728892605642);
	});

	it('should create ids of the class it is called on', () => {
		const orderId = OrderId.generate(new Date('2024-02-01T00:00:00Z'));
		const next = OrderId.factory();

		expect(orderId).toBeInstanceOf(OrderId);
		expect(OrderId.from(orderId.value)).toBeInstanceOf(OrderId);
		expect(next()).toBeInstanceOf(OrderId);
		expect([orderId.value].map(OrderId.from)[0]).toBeInstanceOf(OrderId);
		expectTypeOf(orderId).toEqualTypeOf<OrderId>();
		expectTypeOf(orderId).not.toEqualTypeOf<ULID>();
		expectTypeOf(OrderId.from(orderId.value)).toEqualTypeOf<OrderId>();
		expectTypeOf(OrderId.from(orderId.value)).not.toEqualTypeOf<ULID>();
		expectTypeOf(next).returns.toEqualTypeOf<OrderId>();
		expectTypeOf(next).returns.not.toEqualTypeOf<ULID>();
		expectTypeOf(ULID.generate()).not.toEqualTypeOf<OrderId>();
		// Detached, the type falls back to ULID, which still has the time
		expectTypeOf([orderId.value].map(ULID.from)).toEqualTypeOf<ULID[]>();
	});

	it('should tell ids of different classes apart, even with the same value', () => {
		const value = '01JA50F56AM0CCDBNVQW3TTWNY';

		expect(OrderId.from(value).equals(OrderId.from(value))).toBe(true);
		expect(OrderId.from(value).equals(InvoiceId.from(value))).toBe(false);
		expect(ULID.from(value).equals(EventId.from(value))).toBe(false);
	});

	it('should throw when trying to create a ULID from an undefined variable', () => {
		const value: string | undefined = undefined;
		expect(() => ULID.from(value as unknown as string)).toThrow(new InvalidIdException({ value, idType: 'ULID' }));
	});

	it.each([
		['not a ULID', '123-abc'],
		['25 characters', '01JA50F56AM0CCDBNVQW3TTWN'],
		['27 characters', '01JA50F56AM0CCDBNVQW3TTWNYA'],
		['an I, which is not Crockford base32', '01JA50F56AM0CCDBNVQW3TTWNI'],
		['an L, which is not Crockford base32', '01JA50F56AM0CCDBNVQW3TTWNL'],
		['an O, which is not Crockford base32', '01JA50F56AM0CCDBNVQW3TTWNO'],
		['a U, which is not Crockford base32', '01JA50F56AM0CCDBNVQW3TTWNU'],
		['a lower-case u', '01ja50f56am0ccdbnvqw3ttwnu'],
		['a time above 48 bits (first character 8)', '81JA50F56AM0CCDBNVQW3TTWNY'],
		['a hyphen', '01JA50F56AM0-CDBNVQW3TTWNY'],
		['a trailing newline', '01JA50F56AM0CCDBNVQW3TTWN\n'],
	])('should throw when creating a ULID from %s', (_, value) => {
		expect(() => ULID.from(value)).toThrow(new InvalidIdException({ value, idType: 'ULID' }));
	});

	it('should name the id class that rejected the value', () => {
		expect(() => OrderId.from('123-abc')).toThrow(new InvalidIdException({ value: '123-abc', idType: 'OrderId' }));
		expect(() => ['01JA50F56AM0CCDBNVQW3TTWNU'].map(OrderId.from)).toThrow(
			new InvalidIdException({ value: '01JA50F56AM0CCDBNVQW3TTWNU', idType: 'OrderId' }),
		);
	});

	it('should throw an InvalidIdException when from() is called detached', () => {
		expect(() => [''].map(ULID.from)).toThrow(new InvalidIdException({ value: '', idType: 'ULID' }));
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
		expect(generatedUlid1.value < generatedUlid2.value).toBe(true);
	});

	it('should generate a ULID for a fixed time', () => {
		const generatedUlid = ULID.generate(new Date('2024-02-01T00:00:00Z'));
		expect(generatedUlid.value).toHaveLength(26);
		expect(generatedUlid.date).toEqual(new Date('2024-02-01T00:00:00Z'));
	});
});
