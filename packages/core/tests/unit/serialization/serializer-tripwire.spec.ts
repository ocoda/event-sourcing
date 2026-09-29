import { Injectable, type INestApplicationContext, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
	Event,
	EventMap,
	EventSerializationException,
	EventSerializer,
	EventSourcingConfigurationException,
	EventSourcingModule,
	EventStore,
	EventStream,
	type IEventPayload,
	type IEventSerializer,
	JsonEventSerializer,
} from '@ocoda/event-sourcing';
import { Account, AccountId } from '@ocoda/event-sourcing-testing/unit';
import { ClassTransformerEventSerializer } from '@ocoda/event-sourcing/class-transformer';
import { Exclude, Expose, instanceToPlain, Transform, Type } from 'class-transformer';
import {
	CLASS_TRANSFORMER_DECORATORS,
	loadClassTransformerDecorators,
} from '../../../lib/helpers/class-transformer-decorators.js';

// ADR 0001 §3, §6: an event with class-transformer decorators can't switch to the JSON default silently. The module
// loads class-transformer's metadata storage, and the bootstrap fails with a configuration issue for such an event,
// naming the fix.

class Money {
	constructor(
		public readonly amount: number,
		public readonly currency: string,
	) {}
}

@Event('tripwire-deposited')
class Deposited {
	@Type(() => Money)
	readonly amount: Money;

	constructor(amount: Money) {
		this.amount = amount;
	}
}

@Event('tripwire-plain')
class Plain {
	constructor(public readonly note: string) {}
}

@Exclude()
class ExcludedBase {
	@Expose()
	readonly id: string = '';
}

@Event('tripwire-inherited')
class Inherited extends ExcludedBase {
	@Transform(({ value }) => value)
	readonly note: string = '';
}

// Classes nested in an event: 3.x applied their decorators when it stored the event (instanceToPlain), but never read
// them back into instances of their class, as the event has no @Type for them.
class Credentials {
	readonly user: string = 'u';
	@Exclude()
	readonly secret: string = 's3cr3t';
}

class Cents {
	@Expose({ name: 'amount_cents' })
	readonly amountCents: number = 700;
}

/** Decorators that don't change what instanceToPlain returns for an instance of the class. */
@Expose()
class ReadSide {
	@Type(() => Date)
	readonly at: Date = new Date(0);
	@Transform(({ value }) => value, { toClassOnly: true })
	readonly note: string = '';
	@Exclude({ toClassOnly: true })
	readonly hidden: string = '';
}

class Circle {
	readonly radius: number = 1;
}

/** Decorators that do: a @Type with a discriminator adds its property, a class-level @Exclude excludes the rest. */
@Exclude()
class Drawing {
	@Type(() => Object, { discriminator: { property: 'kind', subTypes: [{ value: Circle, name: 'circle' }] } })
	readonly shape: Circle = new Circle();
	@Transform(({ value }) => value, { toPlainOnly: true })
	readonly label: string = '';
}

@Event('tripwire-registered')
class Registered {
	readonly credentials = new Credentials();
}

@Event('tripwire-nested')
class Nested {
	readonly readSide = new ReadSide();
	readonly amounts: unknown[] = [1];
	readonly byCurrency = new Map<string, unknown>();
}

const decoratorsOf = async () => {
	const found = await loadClassTransformerDecorators();
	if (!found) throw new Error('class-transformer is installed for the tests');
	return found;
};

describe('the class-transformer tripwire', () => {
	describe(loadClassTransformerDecorators, () => {
		it('finds the decorators of a class and of its parent classes', async () => {
			const of = await decoratorsOf();

			expect(of(Deposited)).toEqual(['@Type on Deposited.amount']);
			expect(of(Inherited)).toEqual([
				'@Transform on Inherited.note',
				'@Expose on ExcludedBase.id',
				'@Exclude on ExcludedBase',
			]);
			expect(of(Plain)).toEqual([]);
			expect(of(Money)).toEqual([]);
		});

		it("with the scope 'serialize', finds the decorators that change what instanceToPlain returns", async () => {
			const of = await decoratorsOf();

			expect(of(Credentials, 'serialize')).toEqual(['@Exclude on Credentials.secret']);
			expect(of(Cents, 'serialize')).toEqual(['@Expose on Cents.amountCents']);
			expect(of(ReadSide)).toEqual([
				'@Type on ReadSide.at',
				'@Transform on ReadSide.note',
				'@Expose on ReadSide',
				'@Exclude on ReadSide.hidden',
			]);
			expect(of(ReadSide, 'serialize')).toEqual([]);
			expect(of(Drawing, 'serialize')).toEqual([
				'@Type on Drawing.shape',
				'@Transform on Drawing.label',
				'@Exclude on Drawing',
			]);
			expect(of(Inherited, 'serialize')).toEqual([
				'@Transform on Inherited.note',
				'@Expose on ExcludedBase.id',
				'@Exclude on ExcludedBase',
			]);
			expect(of(Money, 'serialize')).toEqual([]);
			// The JSON serializer asks for every class instance it meets
			expect(of(Credentials, 'serialize')).toBe(of(Credentials, 'serialize'));
		});

		it('resolves to undefined without class-transformer, so nothing is checked', async () => {
			const missing = Object.assign(new Error("Cannot find package 'class-transformer'"), {
				code: 'ERR_MODULE_NOT_FOUND',
			});

			await expect(loadClassTransformerDecorators(() => Promise.reject(missing))).resolves.toBeUndefined();
		});

		it('resolves to undefined for a metadata storage it does not know', async () => {
			await expect(loadClassTransformerDecorators(async () => ({}))).resolves.toBeUndefined();
			await expect(loadClassTransformerDecorators(async () => undefined)).resolves.toBeUndefined();
			await expect(
				loadClassTransformerDecorators(async () => ({ defaultMetadataStorage: { _typeMetadatas: {} } })),
			).resolves.toBeUndefined();
		});
	});

	describe('EventMap.registerSerializers', () => {
		it('registers the JSON serializer by default', () => {
			const eventMap = new EventMap();

			eventMap.registerSerializers([Plain]);

			expect(eventMap.serializeEvent(new Plain('a'))).toStrictEqual({ note: 'a' });
			expect(eventMap.deserializeEvent('tripwire-plain', { note: 'a' })).toBeInstanceOf(Plain);
		});

		it('throws for a decorated event that would get the JSON serializer', async () => {
			const eventMap = new EventMap();

			const register = async () =>
				eventMap.registerSerializers([Plain, Deposited], [], { classTransformerDecoratorsOf: await decoratorsOf() });

			await expect(register()).rejects.toThrow(EventSerializationException);
			await expect(register()).rejects.toMatchObject({
				event: 'Deposited',
				reason: 'class-transformer-decorators',
				decorators: ['@Type on Deposited.amount'],
			});
		});

		it('accepts a decorated event with another default serializer, or with a serializer of its own', async () => {
			const classTransformerDecoratorsOf = await decoratorsOf();
			const eventMap = new EventMap();

			eventMap.registerSerializers([Deposited], [], {
				defaultSerializer: ClassTransformerEventSerializer,
				classTransformerDecoratorsOf,
			});
			expect(
				eventMap.deserializeEvent<Deposited>('tripwire-deposited', { amount: { amount: 1 } }).amount,
			).toBeInstanceOf(Money);

			class DepositedSerializer implements IEventSerializer<Deposited> {
				serialize(event: Deposited): IEventPayload<Deposited> {
					return { amount: { ...event.amount } };
				}
				deserialize(payload: IEventPayload<Deposited>): Deposited {
					return new Deposited(new Money(payload.amount.amount, payload.amount.currency));
				}
			}
			EventSerializer(Deposited)(DepositedSerializer);
			const own = new EventMap();
			own.registerSerializers(
				[Deposited],
				[{ metatype: DepositedSerializer, instance: new DepositedSerializer() }] as never,
				{
					classTransformerDecoratorsOf,
				},
			);
			expect(own.deserializeEvent<Deposited>('tripwire-deposited', { amount: { amount: 2 } }).amount).toBeInstanceOf(
				Money,
			);
		});

		describe('an event that holds an instance of a class with decorators', () => {
			it('fails to serialize on the JSON serializers it registers, and names the property', async () => {
				const eventMap = new EventMap();
				eventMap.registerSerializers([Registered, Nested], [], { classTransformerDecoratorsOf: await decoratorsOf() });

				// Why: 3.x stored the payload without the excluded field
				expect(instanceToPlain(new Registered())).toStrictEqual({ credentials: { user: 'u' } });
				expect(() => eventMap.serializeEvent(new Registered())).toThrow(
					"Cannot serialize the event Registered: credentials is an instance of a class with class-transformer decorators (@Exclude on Credentials.secret), which the default JsonEventSerializer ignores. Serialize it with class-transformer: set defaultEventSerializer: ClassTransformerEventSerializer (from '@ocoda/event-sourcing/class-transformer') in EventSourcingModule.forRoot(), or register an @EventSerializer() for the event.",
				);

				const nested = new Nested();
				// An object whose prototype has no constructor has no class to check
				nested.amounts.push(Object.assign(Object.create(Object.create(null)), { two: 2 }));
				expect(eventMap.serializeEvent(nested)).toStrictEqual({
					readSide: { at: new Date(0), note: '', hidden: '' },
					amounts: [1, { two: 2 }],
					byCurrency: {},
				});
				nested.amounts.pop();
				nested.amounts.push(new Cents());
				expect(() => eventMap.serializeEvent(nested)).toThrow(
					expect.objectContaining({
						event: 'Nested',
						reason: 'class-transformer-decorators',
						path: 'amounts[1]',
						decorators: ['@Expose on Cents.amountCents'],
					}),
				);
				nested.amounts.pop();
				nested.byCurrency.set('EUR', { drawing: new Drawing() });
				expect(() => eventMap.serializeEvent(nested)).toThrow(
					expect.objectContaining({ path: 'byCurrency.EUR.drawing' }),
				);
			});

			it('serializes it with class-transformer on the class-transformer default', async () => {
				const eventMap = new EventMap();
				eventMap.registerSerializers([Registered], [], {
					defaultSerializer: ClassTransformerEventSerializer,
					classTransformerDecoratorsOf: await decoratorsOf(),
				});

				expect(eventMap.serializeEvent(new Registered())).toStrictEqual({ credentials: { user: 'u' } });
			});

			it('leaves an own serializer and an unchecked registration alone', async () => {
				@EventSerializer(Registered)
				class RegisteredSerializer extends JsonEventSerializer<Registered> {
					constructor() {
						super(Registered);
					}
				}
				const own = new EventMap();
				own.registerSerializers(
					[Registered],
					[{ metatype: RegisteredSerializer, instance: new RegisteredSerializer() }] as never,
					{ classTransformerDecoratorsOf: await decoratorsOf() },
				);
				expect(own.serializeEvent(new Registered())).toStrictEqual({ credentials: { user: 'u', secret: 's3cr3t' } });

				// Without class-transformer's metadata (a bundled application), nothing is checked
				const unchecked = new EventMap();
				unchecked.registerSerializers([Registered]);
				expect(unchecked.serializeEvent(new Registered())).toStrictEqual({
					credentials: { user: 'u', secret: 's3cr3t' },
				});
			});
		});

		it('checks a factory that returns JSON serializers too', async () => {
			const eventMap = new EventMap();

			expect(() =>
				eventMap.registerSerializers([Deposited], [], {
					defaultSerializer: { for: (event) => JsonEventSerializer.for(event) },
					classTransformerDecoratorsOf: () => ['@Type on Deposited.amount'],
				}),
			).toThrow(EventSerializationException);
		});
	});

	describe('bootstrap', () => {
		@Injectable()
		class Deposits {
			constructor(private readonly eventStore: EventStore) {}

			async roundTrip(): Promise<Deposited> {
				const stream = EventStream.for(Account, AccountId.generate());
				await this.eventStore.appendEvents(stream, [new Deposited(new Money(5, 'EUR'))], { expectedVersion: 0 });
				return this.eventStore.getEvent(stream, 1) as Promise<Deposited>;
			}
		}

		const bootstrap = async (
			root: ReturnType<typeof EventSourcingModule.forRoot>,
		): Promise<INestApplicationContext> => {
			@Module({ imports: [root], providers: [Deposits] })
			class AppModule {}

			const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
			return moduleRef.init();
		};

		it('fails for a decorated event on the JSON default, and names the fix', async () => {
			const bootstrapping = bootstrap(EventSourcingModule.forRoot({ events: [Plain, Deposited] }));

			await expect(bootstrapping).rejects.toThrow(EventSourcingConfigurationException);
			await expect(bootstrapping).rejects.toThrow(
				"Invalid EventSourcingModule configuration (1 issue)\n- [class-transformer-decorators] The event Deposited uses class-transformer decorators (@Type on Deposited.amount), which the default JsonEventSerializer ignores: set defaultEventSerializer: ClassTransformerEventSerializer (from '@ocoda/event-sourcing/class-transformer') in EventSourcingModule.forRoot(), or register an @EventSerializer() for the event.",
			);
		});

		it('boots with defaultEventSerializer: ClassTransformerEventSerializer and reads the event back', async () => {
			const app = await bootstrap(
				EventSourcingModule.forRoot({ events: [Deposited], defaultEventSerializer: ClassTransformerEventSerializer }),
			);

			const read = await app.get(Deposits).roundTrip();

			expect(read).toBeInstanceOf(Deposited);
			expect(read.amount).toBeInstanceOf(Money);
			await app.close();
		});

		it('takes defaultEventSerializer from forRootAsync', async () => {
			const app = await bootstrap(
				EventSourcingModule.forRootAsync({
					useFactory: async () => ({ events: [Deposited], defaultEventSerializer: ClassTransformerEventSerializer }),
				}),
			);

			expect((await app.get(Deposits).roundTrip()).amount).toBeInstanceOf(Money);
			await app.close();
		});

		it('boots on the JSON default when the decorated event has a serializer of its own', async () => {
			@EventSerializer(Deposited)
			class DepositedSerializer extends ClassTransformerEventSerializer<Deposited> {
				constructor() {
					super(Deposited);
				}
			}

			@Module({
				imports: [EventSourcingModule.forRoot({ events: [Plain, Deposited] })],
				providers: [Deposits, DepositedSerializer],
			})
			class AppModule {}

			const app = await (await Test.createTestingModule({ imports: [AppModule] }).compile()).init();

			expect((await app.get(Deposits).roundTrip()).amount).toBeInstanceOf(Money);
			await app.close();
		});

		it('fails an append, before it writes anything, for an event that holds an instance of a class with decorators', async () => {
			const app = await bootstrap(EventSourcingModule.forRoot({ events: [Plain, Registered] }));
			const eventStore = app.get(EventStore);
			const stream = EventStream.for(Account, AccountId.generate());

			await expect(eventStore.appendEvents(stream, [new Registered()], { expectedVersion: 0 })).rejects.toMatchObject({
				reason: 'class-transformer-decorators',
				path: 'credentials',
			});
			// The stream is still empty
			await eventStore.appendEvents(stream, [new Plain('a')], { expectedVersion: 0 });
			await app.close();
		});

		it('checks nothing without class-transformer', async () => {
			const moduleRef = await Test.createTestingModule({
				imports: [EventSourcingModule.forRoot({ events: [Plain, Deposited] })],
			})
				.overrideProvider(CLASS_TRANSFORMER_DECORATORS)
				.useFactory({ factory: () => undefined })
				.compile();

			const app = await moduleRef.init();

			expect(app.get(EventMap).serializeEvent(new Deposited(new Money(1, 'EUR')))).toStrictEqual({
				amount: { amount: 1, currency: 'EUR' },
			});
			await app.close();
		});

		it('fails for a decorated event registered by a feature module, naming the decorators of its parent too', async () => {
			@Module({ imports: [EventSourcingModule.forFeature({ events: [Inherited] })] })
			class FeatureModule {}

			const moduleRef = await Test.createTestingModule({
				imports: [EventSourcingModule.forRoot({ events: [Plain] }), FeatureModule],
			}).compile();

			await expect(moduleRef.init()).rejects.toMatchObject({
				issues: [
					{
						kind: 'class-transformer-decorators',
						message: expect.stringContaining(
							'The event Inherited uses class-transformer decorators (@Transform on Inherited.note, @Expose on ExcludedBase.id, @Exclude on ExcludedBase)',
						),
					},
				],
			});
			// The failed init rejects close() too
			await moduleRef.close().catch(() => undefined);
		});
	});
});
