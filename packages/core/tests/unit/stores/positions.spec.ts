import { type PositionLike, toPosition } from '@ocoda/event-sourcing';

describe(toPosition, () => {
	it.each([
		['a decimal string (a BIGINT read as text)', '42', 42n],
		['the largest BIGINT as a string', '9223372036854775807', 9223372036854775807n],
		['a string with leading zeros', '007', 7n],
		['a safe integer', 42, 42n],
		['the largest safe integer', Number.MAX_SAFE_INTEGER, 9007199254740991n],
		['a bigint', 42n, 42n],
		['zero, the counter of an empty pool', 0, 0n],
		['-0', -0, 0n],
		['an Int64 object (MongoDB Long)', { toBigInt: () => 9007199254740993n }, 9007199254740993n],
	])('converts %s', (_, value, expected) => {
		expect(toPosition(value)).toBe(expected);
	});

	it.each([
		['a negative string', '-1'],
		['an empty string', ''],
		['a decimal fraction', '1.5'],
		['padded digits', ' 1'],
		['a hexadecimal string', '0x10'],
		['an exponent', '1e3'],
		['a negative number', -1],
		['a fraction', 1.5],
		['NaN', Number.NaN],
		['an unsafe integer, which may have lost precision', 2 ** 53],
		['a negative bigint', -1n],
		['null', null],
		['undefined', undefined],
		['a boolean', true],
		['an object without toBigInt', {}],
		['an Int64 object with a negative value', { toBigInt: () => -1n }],
		['an object whose toBigInt returns a number', { toBigInt: () => 1 }],
	])('rejects %s', (_, value) => {
		expect(() => toPosition(value as PositionLike)).toThrow(RangeError);
		expect(() => toPosition(value as PositionLike)).toThrow(
			/^Not a global position: .+\. Expected a non-negative integer\.$/,
		);
	});

	it('shows the value it rejects', () => {
		expect(() => toPosition('-1')).toThrow('Not a global position: "-1".');
		expect(() => toPosition(-1n)).toThrow('Not a global position: -1n.');
		expect(() => toPosition(Object.create(null))).toThrow('Not a global position: object.');
	});
});
