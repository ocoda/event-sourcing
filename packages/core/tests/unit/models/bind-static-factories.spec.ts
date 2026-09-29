import { Id, ULID, UUID } from '@ocoda/event-sourcing';
import { bindStaticFactories } from '../../../lib/models/bind-static-factories.js';

describe(bindStaticFactories, () => {
	it('binds the factories of the id classes and keeps them out of the enumerable keys', () => {
		for (const [cls, names] of [
			[Id, ['from']],
			[UUID, ['from', 'generate']],
			[ULID, ['from', 'generate', 'factory']],
		] as const) {
			for (const name of names) {
				expect(Object.getOwnPropertyDescriptor(cls, name)).toMatchObject({ enumerable: false, configurable: true });
			}
			expect(Object.keys(cls)).toEqual([]);
		}
	});

	it('binds a factory to the class it is read from', () => {
		class Factory {
			static create(this: unknown, value: string) {
				return { receiver: this, value };
			}
		}
		class SubFactory extends Factory {}
		bindStaticFactories(Factory, ['create']);

		const { create } = SubFactory;

		expect(create('a')).toEqual({ receiver: SubFactory, value: 'a' });
		expect(Factory.create('b')).toEqual({ receiver: Factory, value: 'b' });
	});

	it('hands out the method unbound when it is read from something else than a class', () => {
		class Factory {
			static create(this: unknown) {
				return this;
			}
		}
		const create = Factory.create;
		bindStaticFactories(Factory, ['create']);

		const getter = Object.getOwnPropertyDescriptor(Factory, 'create')?.get;

		expect(getter?.call(undefined)).toBe(create);
	});

	it('rejects a name the class declares no static method for', () => {
		class Factory {
			static readonly value = 1;
		}
		class SubFactory extends Factory {}

		expect(() => bindStaticFactories(Factory, ['create'])).toThrow(
			new TypeError('Factory declares no static method create'),
		);
		expect(() => bindStaticFactories(Factory, ['value'])).toThrow(TypeError);
		expect(() => bindStaticFactories(SubFactory, ['value'])).toThrow(TypeError);
	});
});
