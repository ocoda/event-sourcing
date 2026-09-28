/**
 * Objects that `marshall()` stores natively (binary data, boxed primitives and `NumberValue`); they are left untouched.
 * Typed arrays, `DataView` and `Buffer` are detected with `ArrayBuffer.isView()`.
 */
const NATIVELY_MARSHALLED_TYPES = new Set([
	'ArrayBuffer',
	'Blob',
	'File',
	'Boolean',
	'Number',
	'String',
	'NumberValue',
]);

/**
 * Prepares an event or snapshot payload for `marshall(..., { convertClassInstanceToMap: true })`.
 *
 * `marshall()` converts class instances through their enumerable properties, which turns a `Date` into an empty
 * map (`{ M: {} }`) and silently loses its value. Dates are therefore converted to ISO-8601 strings (or `null` for
 * an invalid date), which is exactly what `JSON.stringify()` - and therefore the SQL stores - persist.
 * Everything else is passed on unchanged, so `marshall()` keeps handling it (including `removeUndefinedValues`)
 * the way it did before.
 *
 * The input is never mutated; containers holding a date are copied.
 */
export function normalizePayload(value: unknown): unknown {
	if (value === null || typeof value !== 'object') {
		return value;
	}

	if (value instanceof Date) {
		return value.toJSON();
	}

	if (Array.isArray(value)) {
		return value.map((item) => normalizePayload(item));
	}

	// Mirror the type checks of marshall(), which detects sets and maps by constructor name
	const typeName: unknown = value.constructor?.name;

	if (typeName === 'Set') {
		return new Set(Array.from(value as Set<unknown>, (item) => normalizePayload(item)));
	}

	if (typeName === 'Map') {
		return new Map(Array.from(value as Map<unknown, unknown>, ([key, item]) => [key, normalizePayload(item)]));
	}

	if (ArrayBuffer.isView(value) || (typeof typeName === 'string' && NATIVELY_MARSHALLED_TYPES.has(typeName))) {
		return value;
	}

	// Plain objects and class instances: marshall() maps their enumerable properties, so walk the same properties.
	// A prototype-less object keeps a '__proto__' key an own property instead of turning it into the prototype.
	const normalized: Record<string, unknown> = Object.create(null);
	for (const key in value) {
		normalized[key] = normalizePayload((value as Record<string, unknown>)[key]);
	}

	return normalized;
}
