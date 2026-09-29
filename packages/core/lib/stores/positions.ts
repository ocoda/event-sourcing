/**
 * The forms in which database drivers return a global position: a decimal string (a `BIGINT` read as text), a number,
 * a bigint, or an Int64 object with a `toBigInt()` method (the `Long` of the MongoDB driver).
 */
export type PositionLike = string | number | bigint | { toBigInt(): bigint };

const DECIMAL = /^\d+$/;

const invalid = (value: unknown): RangeError => {
	let shown: string;
	try {
		shown = typeof value === 'bigint' ? `${value}n` : typeof value === 'string' ? JSON.stringify(value) : String(value);
	} catch {
		shown = typeof value;
	}
	return new RangeError(`Not a global position: ${shown}. Expected a non-negative integer.`);
};

/**
 * Converts a global position as a database driver returns it to a bigint. Every store converts its positions with it,
 * so that they compare and serialize the same everywhere.
 *
 * Accepts a non-negative integer: a string of decimal digits, a safe integer number, a bigint, or an object with a
 * `toBigInt()` method. Anything else is corrupt data and throws a `RangeError`, rather than becoming a wrong position.
 */
export const toPosition = (value: PositionLike): bigint => {
	let position: unknown;
	switch (typeof value) {
		case 'bigint':
			position = value;
			break;
		case 'number':
			if (!Number.isSafeInteger(value)) {
				throw invalid(value);
			}
			position = BigInt(value);
			break;
		case 'string':
			if (!DECIMAL.test(value)) {
				throw invalid(value);
			}
			position = BigInt(value);
			break;
		case 'object':
			if (value !== null && typeof value.toBigInt === 'function') {
				position = value.toBigInt();
				break;
			}
			throw invalid(value);
		default:
			throw invalid(value);
	}
	if (typeof position !== 'bigint' || position < 0n) {
		throw invalid(value);
	}
	return position;
};
