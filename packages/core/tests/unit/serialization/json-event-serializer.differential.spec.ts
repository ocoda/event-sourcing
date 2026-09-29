import { EventSerializationException, Id, JsonEventSerializer, ValueObject } from '@ocoda/event-sourcing';
import { instanceToPlain, plainToInstance } from 'class-transformer';

// ADR 0001 §6: on classes without class-transformer decorators, JsonEventSerializer returns what class-transformer
// 0.5.1 (the 3.x default) returns. Each case runs both and compares the results with toStrictEqual and, at every
// level, the prototype and the own keys in order. The deliberate differences are at the end.

type AnyClass = new () => object;

/**
 * Asserts that two values have the same shape at every level: the same primitives (`Object.is`), the same prototypes,
 * the same own keys in the same order, dates with the same time and buffers with the same bytes. Functions match by
 * source, as each `new cls()` creates its own arrow functions.
 */
const expectSameShape = (actual: unknown, expected: unknown, path = '$'): void => {
	if (typeof expected === 'function') {
		expect(typeof actual, `${path}`).toBe('function');
		expect(String(actual), `${path}`).toBe(String(expected));
		return;
	}
	if (expected === null || typeof expected !== 'object') {
		expect(Object.is(actual, expected), `${path}: ${String(actual)} is ${String(expected)}`).toBe(true);
		return;
	}
	expect(actual, `${path}`).toBeTypeOf('object');
	expect(Object.getPrototypeOf(actual), `${path}: prototype`).toBe(Object.getPrototypeOf(expected));
	if (expected instanceof Date) {
		expect(Object.is((actual as Date).getTime(), expected.getTime()), `${path}: time`).toBe(true);
		expect(actual, `${path}: a copy`).not.toBe(expected);
		return;
	}
	if (Buffer.isBuffer(expected)) {
		expect((actual as Buffer).equals(expected), `${path}: bytes`).toBe(true);
		return;
	}
	expect(Reflect.ownKeys(actual as object), `${path}: keys`).toEqual(Reflect.ownKeys(expected));
	for (const key of Reflect.ownKeys(expected)) {
		expectSameShape(
			(actual as Record<PropertyKey, unknown>)[key],
			(expected as Record<PropertyKey, unknown>)[key],
			`${path}.${String(key)}`,
		);
	}
};

const expectSame = (actual: unknown, expected: unknown): void => {
	expectSameShape(actual, expected);
	expect(actual).toStrictEqual(expected);
};

// ---- the corpus ------------------------------------------------------------------------------------------------------

class Money {
	constructor(
		public readonly amount: number,
		public readonly currency: string,
	) {}

	get formatted(): string {
		return `${this.amount} ${this.currency}`;
	}

	toJSON(): string {
		return this.formatted;
	}

	add(other: Money): Money {
		return new Money(this.amount + other.amount, this.currency);
	}
}

class Balance extends ValueObject<{ value: number; currency: string }> {
	static of(value: number): Balance {
		return new Balance({ value, currency: 'EUR' });
	}

	get value(): number {
		return this.props.value;
	}
}

class Owner {
	constructor(
		public readonly id: Id,
		public readonly since: Date,
		public readonly roles: Set<string>,
	) {}
}

const OPENED_ON = new Date('2021-03-04T05:06:07.089Z');
const IGNORED: unique symbol = Symbol('ignored');
const sharedCallback = (): string => 'called';

/** An event with every kind of value that 3.x events carried, and some they shouldn't have. */
class CorpusEvent {
	text = 'unicode ✓ 🧾 ÿ';
	count = 42;
	negativeZero = -0;
	notANumber = Number.NaN;
	flag = false;
	nothing: null = null;
	missing: undefined = undefined;
	openedOn = new Date(OPENED_ON);
	invalidDate = new Date(Number.NaN);
	id = Id.from('account-1');
	balance = Balance.of(10);
	money = new Money(12.5, 'EUR');
	owner = new Owner(Id.from('owner-1'), new Date(OPENED_ON), new Set(['admin', 'auditor']));
	tags = new Set(['a', 'b', 'a']);
	limits = new Map<string, unknown>([
		['daily', 100],
		['nested', new Map([['inner', new Date(OPENED_ON)]])],
		['money', new Money(1, 'USD')],
		['list', [1, { two: 2 }]],
	]);
	mapKeys = new Map<unknown, unknown>([
		[1, 'number key'],
		[true, 'boolean key'],
		['__proto__', 'dropped'],
		['constructor', 'dropped'],
		[Number.NaN, 'not a number key'],
		['kept', 'kept'],
	]);
	nested = [1, [2, [3, { four: new Date(OPENED_ON) }]], { five: [new Money(5, 'GBP')] }];
	// oxlint-disable-next-line no-sparse-arrays
	sparse = [1, , 3];
	withUndefined = { present: 1, absent: undefined };
	nullPrototype = Object.assign(Object.create(null), { a: 1, b: { c: 2 } });
	typedArray = new Uint8Array([1, 2, 3]);
	boxed = new String('ab');
	pattern = /abc/g;
	error = new Error('not serializable');
	objects = new Set([{ a: 1 }, new Money(2, 'EUR')]);
	protoKey = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
	callback = sharedCallback;
	functionsInArrays = [sharedCallback];
	[IGNORED] = 'symbol keys are dropped';

	constructor() {
		Object.defineProperty(this, 'hidden', { value: 'not enumerable', enumerable: false });
	}

	get derived(): string {
		return 'prototype getter';
	}

	toJSON(): object {
		return { replaced: true };
	}

	describe(): string {
		return 'a method';
	}
}

/** An own enumerable getter is read like a field. (Deserializing onto it fails in class-transformer, see below.) */
class OwnGetterEvent {
	kind = 'own getter';

	constructor() {
		Object.defineProperty(this, 'computed', { get: () => 'own getter', enumerable: true });
	}
}

class BinaryEvent {
	big = 10n ** 20n;
	bytes = Buffer.from('bytes');
	nested = { big: -1n, bytes: Buffer.from([0, 255]) };
}

class SharedReferences {
	shared = { value: 1 };
	first = this.shared;
	second = [this.shared, this.shared];
}

// ---- serialize ------------------------------------------------------------------------------------------------------

describe('JsonEventSerializer and class-transformer 0.5.1 on undecorated classes', () => {
	const serializeCases: [string, () => object][] = [
		['every value 3.x events carried', () => new CorpusEvent()],
		['bigint and Buffer', () => new BinaryEvent()],
		['an own enumerable getter', () => new OwnGetterEvent()],
		['shared references, copied each time', () => new SharedReferences()],
		['a plain object', () => ({ a: 1, b: { c: [new Date(OPENED_ON)] } })],
		['a ValueObject', () => Balance.of(3)],
		['an empty class', () => new (class Empty {})()],
	];

	describe.each(serializeCases)('serialize: %s', (_, create) => {
		it('returns what instanceToPlain returns', () => {
			const event = create();
			const json = JsonEventSerializer.for(event.constructor as AnyClass).serialize(event);
			const classTransformer = instanceToPlain(event);

			expectSame(json, classTransformer);
		});
	});

	it('serialize: stores the fields as 3.x did', () => {
		const payload = JsonEventSerializer.for(CorpusEvent).serialize(new CorpusEvent()) as Record<string, unknown>;

		expect(payload.openedOn).toBeInstanceOf(Date);
		expect(payload.id).toStrictEqual({ props: { value: 'account-1' } });
		expect(payload.balance).toStrictEqual({ props: { value: 10, currency: 'EUR' } });
		expect(payload.money).toStrictEqual({ amount: 12.5, currency: 'EUR' });
		expect(payload.tags).toStrictEqual(['a', 'b']);
		expect(payload.limits).toMatchObject({ daily: 100, nested: { inner: OPENED_ON }, money: { amount: 1 } });
		expect(payload.mapKeys).toStrictEqual({
			'1': 'number key',
			true: 'boolean key',
			NaN: 'not a number key',
			kept: 'kept',
		});
		expect(payload.sparse).toStrictEqual([1, 3]);
		expect(payload.callback).toBe('called');
		expect(payload).not.toHaveProperty('derived');
		expect(payload).not.toHaveProperty('hidden');
		expect(payload).not.toHaveProperty('replaced');
		expect(payload).toHaveProperty('missing', undefined);
		expect(Object.hasOwn(payload.protoKey as object, '__proto__')).toBe(false);
	});

	// ---- deserialize --------------------------------------------------------------------------------------------------

	class Account {
		version = 1;
		balance = Balance.of(0);
		label?: string;
		private _nickname = '';
		handler = sharedCallback;

		constructor(
			public readonly accountId?: string,
			public readonly openedOn?: Date | string,
		) {}

		get summary(): string {
			return `${this.accountId}@${this.version}`;
		}

		get nickname(): string {
			return this._nickname;
		}

		set nickname(value: string) {
			this._nickname = value.toUpperCase();
		}

		close(): void {}
	}
	// A data property of the prototype, like the defaults some classes put there
	Object.defineProperty(Account.prototype, 'kind', { value: 'account', writable: true });

	const deserializeCases: [string, AnyClass, () => object][] = [
		['a payload that 3.x wrote to a SQL store (JSON)', CorpusEvent, () => jsonPayloadOf(new CorpusEvent())],
		['a payload as the in-memory store and MongoDB return it', CorpusEvent, () => rawPayloadOf(new CorpusEvent())],
		['bigint and Buffer', BinaryEvent, () => rawPayloadOf(new BinaryEvent())],
		['an older payload: the constructor defaults fill the missing fields', Account, () => ({ accountId: 'a-1' })],
		[
			'extra, nested and undefined fields',
			Account,
			() => ({ accountId: 'a-1', version: undefined, extra: { deep: [1, { deeper: new Date(OPENED_ON) }] } }),
		],
		[
			'keys of methods, getters and function fields are skipped',
			Account,
			() => ({ accountId: 'a-1', summary: 'x', close: 'x', handler: 'x', toString: 'x', valueOf: 1 }),
		],
		['a setter is called', Account, () => ({ nickname: 'shorty' })],
		['a data property of the prototype is skipped', Account, () => ({ kind: 'savings' })],
		[
			'__proto__ and constructor keys are skipped',
			Account,
			() =>
				JSON.parse(
					'{"__proto__": {"polluted": true}, "constructor": "x", "accountId": "a-1", "nested": {"__proto__": {"polluted": true}, "toString": "z", "hasOwnProperty": 1, "kept": 1}}',
				),
		],
		['a nested ValueObject stays plain', Account, () => ({ balance: { props: { value: 5, currency: 'EUR' } } })],
		['dates are copied', Account, () => ({ openedOn: new Date(OPENED_ON) })],
		[
			'arrays and sets become arrays',
			Account,
			// oxlint-disable-next-line no-sparse-arrays
			() => ({ list: [1, [2, { three: 3 }]], set: new Set([1, { two: 2 }]), sparse: [1, , 3] }),
		],
		['null-prototype objects become plain', Account, () => ({ nested: Object.assign(Object.create(null), { a: 1 }) })],
		['non-object payloads are returned as they are', Account, () => null as unknown as object],
	];

	describe.each(deserializeCases)('deserialize: %s', (_, cls, payloadOf) => {
		it('returns what plainToInstance returns', () => {
			const json = JsonEventSerializer.for(cls).deserialize(payloadOf() as never);
			const classTransformer = plainToInstance(cls, payloadOf());

			expectSame(json, classTransformer);
		});
	});

	it('deserialize: copies the payload, so the event shares nothing with it', () => {
		const payload = rawPayloadOf(new CorpusEvent()) as Record<string, unknown>;
		const event = JsonEventSerializer.for(CorpusEvent).deserialize(payload as never) as unknown as Record<
			string,
			unknown
		>;

		expect(event).toBeInstanceOf(CorpusEvent);
		for (const key of ['openedOn', 'money', 'owner', 'nested', 'limits']) {
			expect(event[key], `${key}`).toStrictEqual(payload[key]);
			expect(event[key], `${key}`).not.toBe(payload[key]);
		}
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it('round trip: reads back what 3.x read back', () => {
		const event = new CorpusEvent();
		const serializer = JsonEventSerializer.for(CorpusEvent);

		const json = serializer.deserialize(JSON.parse(JSON.stringify(serializer.serialize(event))));
		const classTransformer = plainToInstance(CorpusEvent, JSON.parse(JSON.stringify(instanceToPlain(event))));

		expectSame(json, classTransformer);
		expect(json.openedOn).toBe(OPENED_ON.toISOString());
		expect(json.id).toStrictEqual({ props: { value: 'account-1' } });
	});

	// ---- deliberate differences ---------------------------------------------------------------------------------------

	describe('deliberate differences', () => {
		it('a circular reference throws an EventSerializationException instead of overflowing the stack', () => {
			class Node {
				child?: Node;
				parent?: Node;
				label = 'root';
			}
			const root = new Node();
			root.child = new Node();
			root.child.parent = root;

			expect(() => instanceToPlain(root)).toThrow(RangeError);
			expect(() => JsonEventSerializer.for(Node).serialize(root)).toThrow(EventSerializationException);
		});

		it('an inherited or own getter without a setter is skipped instead of throwing a TypeError', () => {
			class Base {
				get kind(): string {
					return 'base';
				}
			}
			class Derived extends Base {
				name = '';
			}

			expect(() => plainToInstance(Derived, { kind: 'x', name: 'n' })).toThrow(TypeError);
			const event = JsonEventSerializer.for(Derived).deserialize({ kind: 'x', name: 'n' } as never);
			expect(event).toBeInstanceOf(Derived);
			expect(event.kind).toBe('base');
			expect(event.name).toBe('n');

			expect(() => plainToInstance(OwnGetterEvent, { computed: 'x' })).toThrow(TypeError);
			const own = JsonEventSerializer.for(OwnGetterEvent).deserialize({ computed: 'x' } as never);
			expect((own as { computed?: string }).computed).toBe('own getter');
		});

		it('a nested constructor key is skipped instead of throwing a TypeError', () => {
			// class-transformer takes an object's `constructor` for its class, and fails when it isn't one
			class Holder {
				nested?: unknown;
			}
			const event = { nested: { constructor: 'x', kept: 1 } };
			const payload = JSON.parse('{"nested": {"constructor": "x", "kept": 1}}');

			expect(() => instanceToPlain(event)).toThrow(TypeError);
			expect(JsonEventSerializer.for(Holder).serialize(event)).toStrictEqual({ nested: { kept: 1 } });
			expect(() => plainToInstance(Holder, payload)).toThrow(TypeError);
			expect(JsonEventSerializer.for(Holder).deserialize(payload).nested).toStrictEqual({ kept: 1 });
		});

		it('a nested class instance in a payload becomes a plain object instead of an instance of its class', () => {
			class Holder {
				money?: unknown;
			}
			const payload = { money: new Money(1, 'EUR') };

			expect(plainToInstance(Holder, payload).money).toBeInstanceOf(Money);
			const money = JsonEventSerializer.for(Holder).deserialize(payload).money;
			expect(Object.getPrototypeOf(money)).toBe(Object.prototype);
			expect(money).toStrictEqual({ amount: 1, currency: 'EUR' });
		});
	});
});

/** What a SQL store returns: the JSON of the payload. */
function jsonPayloadOf(event: object): object {
	return JSON.parse(JSON.stringify(instanceToPlain(event)));
}

/** What the in-memory store and MongoDB return: the serialized payload with its dates, bigints and buffers. */
function rawPayloadOf(event: object): object {
	return instanceToPlain(event);
}
