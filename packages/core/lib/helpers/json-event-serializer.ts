import type { Type } from '@nestjs/common';
import { EventSerializationException } from '../exceptions/index.js';
import type { IEvent, IEventPayload, IEventSerializer } from '../interfaces/index.js';
import { type ClassTransformerDecoratorsOf, nestedClassCheckOf } from './class-transformer-decorators.js';

/**
 * The default event serializer. It needs no decorators and no dependency, and for event classes without
 * class-transformer decorators it returns the payloads and events that class-transformer 0.5.1, the default of 3.x,
 * returns, so data that 3.x stored reads back unchanged.
 *
 * `serialize` turns the event into plain objects:
 * - It copies the own enumerable string keys, recursively. Nested class instances become plain objects, so a
 *   `ValueObject` such as an `Id` is stored as `{ props: { value } }`. Getters and `toJSON` on the prototype are
 *   ignored, and so are symbol keys and the keys `__proto__` and `constructor`.
 * - A `Date` stays a `Date` (a copy): the SQL stores write it as an ISO string, MongoDB as a BSON date.
 * - A `Set` and an array become arrays (the holes of a sparse array are dropped), and a `Map` becomes an object with a
 *   key per entry.
 * - `undefined`, `bigint`s and `Buffer`s (a copy) are kept as they are; a store may still reject them. A function in
 *   an own property is called and its result stored, as class-transformer does, so keep functions out of events.
 * - A circular reference throws an `EventSerializationException`, so an append fails before it writes anything.
 *
 * `deserialize` calls the constructor without arguments, so the defaults it assigns fill the fields that an older
 * payload lacks, then copies the payload onto the event. It skips the keys `__proto__` and `constructor`, getters
 * without a setter, and methods. Nested objects stay plain objects (copies), so a nested `ValueObject` reads back as
 * `{ props: { value } }`, as in 3.x; dates and buffers are copied. The value types of the MongoDB driver (`Binary`,
 * `Long`, `ObjectId`…) are kept as they are: class-transformer reads them back as instances too (and fails on a
 * `Decimal128`).
 *
 * Events with class-transformer decorators (`@Type`, `@Transform`, `@Expose`, `@Exclude`) need
 * `ClassTransformerEventSerializer` from `@ocoda/event-sourcing/class-transformer`. When the module gives an event this
 * serializer by default, the application fails to bootstrap if the event class has such decorators (a
 * `class-transformer-decorators` issue of an `EventSourcingConfigurationException`), and an append
 * fails, before it writes anything, if the event holds an instance of a class whose decorators would have changed the
 * payload that 3.x stored.
 *
 * @example
 * eventMap.register(AccountOpenedEvent, JsonEventSerializer.for(AccountOpenedEvent));
 */
export class JsonEventSerializer<E extends IEvent = IEvent> implements IEventSerializer<E> {
	protected constructor(protected readonly eventType: Type<E>) {}

	static for<E extends IEvent>(event: Type<E>): JsonEventSerializer<E> {
		return new JsonEventSerializer(event);
	}

	serialize(event: E): IEventPayload<E> {
		return toPlain(event, {
			event: this.eventType.name,
			ancestors: new Set(),
			path: [],
			decoratorsOf: nestedClassCheckOf(this),
		}) as IEventPayload<E>;
	}

	deserialize(payload: IEventPayload<E>): E {
		// Like class-transformer, which returns anything but an object as it is
		if (payload === null || typeof payload !== 'object') {
			return payload as E;
		}
		return copyOnto(new this.eventType(), payload);
	}
}

type PathSegment = string | number;

interface SerializationState {
	/** The class name of the event, for the exception. */
	event: string;
	/** The objects that contain the value being serialized: meeting one again is a circular reference. */
	ancestors: Set<object>;
	/** The keys from the event to the value being serialized. */
	path: PathSegment[];
	/** Finds the class-transformer decorators of a class, when the registration asked for the check. */
	decoratorsOf?: ClassTransformerDecoratorsOf;
}

/** class-transformer copies a `Buffer` wherever the runtime has one. */
const isBuffer = (value: unknown): value is Buffer => typeof Buffer !== 'undefined' && Buffer.isBuffer(value);

const isSkippedKey = (key: unknown): boolean => key === '__proto__' || key === 'constructor';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

const formatPath = (path: PathSegment[]): string =>
	path
		.map((segment, index) => {
			if (typeof segment === 'number') return `[${segment}]`;
			if (IDENTIFIER.test(segment)) return index === 0 ? segment : `.${segment}`;
			return `[${JSON.stringify(segment)}]`;
		})
		.join('');

/**
 * Refuses an instance of a class whose class-transformer decorators would have shaped the payload that 3.x stored,
 * such as an `@Exclude()`d field of a value object: this serializer ignores them.
 */
const checkClass = (value: object, state: SerializationState): void => {
	if (!state.decoratorsOf) return;
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype === Object.prototype || prototype === null) return;
	const cls = (prototype as { constructor?: unknown }).constructor;
	if (typeof cls !== 'function') return;
	const decorators = state.decoratorsOf(cls, 'serialize');
	if (decorators.length > 0) {
		throw new EventSerializationException({
			event: state.event,
			reason: 'class-transformer-decorators',
			path: formatPath(state.path),
			decorators,
		});
	}
};

/**
 * A value type of the MongoDB driver (`Binary`, `Long`, `Decimal128`, `ObjectId`…), which it returns in a payload.
 * class-transformer reads it back as a copy of the instance. A plain object with a `_bsontype` key is not one.
 */
const isBsonValue = (value: object): boolean => {
	const prototype: unknown = Object.getPrototypeOf(value);
	return (
		prototype !== Object.prototype &&
		prototype !== null &&
		typeof (value as { _bsontype?: unknown })._bsontype === 'string'
	);
};

const enter = (value: object, state: SerializationState): void => {
	if (state.ancestors.has(value)) {
		throw new EventSerializationException({
			event: state.event,
			reason: 'circular-reference',
			path: formatPath(state.path),
		});
	}
	state.ancestors.add(value);
};

const toPlain = (value: unknown, state: SerializationState): unknown => {
	if (Array.isArray(value) || value instanceof Set) {
		enter(value, state);
		const plain: unknown[] = [];
		let position = 0;
		// forEach skips the holes of a sparse array, as class-transformer does
		(value as { forEach(callback: (item: unknown, index: unknown) => void): void }).forEach((item, index) => {
			state.path.push(typeof index === 'number' ? index : position);
			plain.push(toPlain(item, state));
			state.path.pop();
			position++;
		});
		state.ancestors.delete(value);
		return plain;
	}
	if (value instanceof Date) {
		return new Date(value.valueOf());
	}
	if (isBuffer(value)) {
		return Buffer.from(value);
	}
	if (value === null || typeof value !== 'object') {
		return value;
	}

	enter(value, state);
	const plain: Record<PropertyKey, unknown> = {};
	if (value instanceof Map) {
		for (const [key, item] of value) {
			if (isSkippedKey(key)) continue;
			state.path.push(String(key));
			plain[key as PropertyKey] = toPlain(item, state);
			state.path.pop();
		}
	} else {
		checkClass(value, state);
		for (const key of Object.keys(value)) {
			if (isSkippedKey(key)) continue;
			const property = (value as Record<string, unknown>)[key];
			state.path.push(key);
			plain[key] = toPlain(property instanceof Function ? property.call(value) : property, state);
			state.path.pop();
		}
	}
	state.ancestors.delete(value);
	return plain;
};

const fromPlain = (value: unknown): unknown => {
	if (Array.isArray(value) || value instanceof Set) {
		const copy: unknown[] = [];
		(value as { forEach(callback: (item: unknown) => void): void }).forEach((item) => {
			copy.push(fromPlain(item));
		});
		return copy;
	}
	if (value instanceof Date) {
		return new Date(value.valueOf());
	}
	if (isBuffer(value)) {
		return Buffer.from(value);
	}
	if (value === null || typeof value !== 'object' || isBsonValue(value)) {
		return value;
	}
	return copyOnto({}, value);
};

/**
 * Whether assigning the key would hit a getter without a setter: an own accessor of the object, or the nearest one on
 * its prototype chain. class-transformer skips those of the class's own prototype and throws a `TypeError` for the
 * others; this serializer skips them all.
 */
const isGetterOnly = (target: object, key: string): boolean => {
	for (let owner: object | null = target; owner !== null; owner = Object.getPrototypeOf(owner)) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, key);
		if (descriptor) {
			return descriptor.get !== undefined && descriptor.set === undefined;
		}
	}
	return false;
};

/**
 * Copies the payload's keys onto the target, with the rules of class-transformer's `plainToInstance` for a class
 * without decorators: it skips `__proto__` and `constructor`, anything the class's own prototype declares without a
 * setter (methods and getters) and keys whose current value is a function (inherited methods, function fields).
 */
const copyOnto = <T extends object>(target: T, source: object): T => {
	const record = target as Record<string, unknown>;
	const prototype = (target as { constructor?: { prototype?: object } }).constructor?.prototype;
	for (const key of Object.keys(source)) {
		if (isSkippedKey(key)) continue;
		const declared = prototype ? Object.getOwnPropertyDescriptor(prototype, key) : undefined;
		if ((declared && !declared.set) || record[key] instanceof Function || isGetterOnly(target, key)) continue;
		record[key] = fromPlain((source as Record<string, unknown>)[key]);
	}
	return target;
};
