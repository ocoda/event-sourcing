import type { ProviderWrapper } from '@ocoda/event-sourcing';
import {
	Command,
	CommandBus,
	CommandHandler,
	CommandHandlerNotFoundException,
	EventSourcingErrorCode,
	type ICommand,
	type ICommandBus,
	type ICommandHandler,
	InvalidCommandHandlerException,
	MissingCommandHandlerMetadataException,
	type ResultOf,
} from '@ocoda/event-sourcing';
import { COMMAND_HANDLER_METADATA, COMMAND_METADATA } from '@ocoda/event-sourcing/decorators';

// ADR 0001 §7: typed buses. The type assertions are checked by `pnpm typecheck`, the rest at runtime.
describe(CommandBus, () => {
	class AccountId {
		constructor(readonly value: string) {}
	}

	class OpenAccountCommand extends Command<AccountId> {
		constructor(readonly accountOwnerIds: string[] = []) {
			super();
		}
	}

	class CloseAccountCommand extends Command {
		constructor(readonly accountId: string) {
			super();
		}
	}

	// A 3.x command: a plain class
	class AddBookCommand implements ICommand {
		constructor(readonly title: string) {}
	}

	const busWithHandlers = () => {
		const bus = new CommandBus();
		bus.bind({ execute: async () => new AccountId('account-1') }, OpenAccountCommand);
		bus.bind({ execute: async () => undefined }, CloseAccountCommand);
		bus.bind({ execute: async ({ title }: AddBookCommand) => `book:${title}` }, AddBookCommand);
		return bus;
	};

	describe('result types', () => {
		it('infers the result of a Command<TResult> without a type argument', async () => {
			const bus = busWithHandlers();

			const opened = bus.execute(new OpenAccountCommand());
			const closed = bus.execute(new CloseAccountCommand('account-1'));

			expectTypeOf(opened).toEqualTypeOf<Promise<AccountId>>();
			expectTypeOf(closed).toEqualTypeOf<Promise<void>>();
			await expect(opened).resolves.toEqual(new AccountId('account-1'));
			await expect(closed).resolves.toBeUndefined();
		});

		it('keeps both 3.x generic forms compiling', async () => {
			const bus = busWithHandlers();

			// The example app: the command alone, so the result is any
			const bookId = bus.execute<AddBookCommand>(new AddBookCommand('dune'));
			// The docs and e2e: the command and the result
			const typedBookId = bus.execute<AddBookCommand, string>(new AddBookCommand('emma'));
			// No type argument on a plain class
			const inferredBookId = bus.execute(new AddBookCommand('ulysses'));

			expectTypeOf(bookId).resolves.toBeAny();
			expectTypeOf(typedBookId).toEqualTypeOf<Promise<string>>();
			expectTypeOf(inferredBookId).resolves.toBeAny();
			// A typed command with an explicit type argument keeps its result
			expectTypeOf(bus.execute<OpenAccountCommand>(new OpenAccountCommand())).toEqualTypeOf<Promise<AccountId>>();
			await expect(bookId).resolves.toBe('book:dune');
			await expect(typedBookId).resolves.toBe('book:emma');
			await expect(inferredBookId).resolves.toBe('book:ulysses');
		});

		it('resolves ResultOf to the result of a Command, and to any for a plain class', () => {
			expectTypeOf<ResultOf<OpenAccountCommand>>().toEqualTypeOf<AccountId>();
			expectTypeOf<ResultOf<CloseAccountCommand>>().toEqualTypeOf<void>();
			expectTypeOf<ResultOf<AddBookCommand>>().toBeAny();
			expectTypeOf<ICommand>().toEqualTypeOf<object>();
		});

		it('types the handler interface and the bus interface with the result of the command', () => {
			expectTypeOf<ICommandHandler<OpenAccountCommand>['execute']>().returns.toEqualTypeOf<Promise<AccountId>>();
			expectTypeOf<ICommandHandler<AddBookCommand>['execute']>().returns.toEqualTypeOf<Promise<any>>();
			expectTypeOf<ICommandHandler<AddBookCommand, string>['execute']>().returns.toEqualTypeOf<Promise<string>>();
			expectTypeOf<ICommandHandler['execute']>().returns.toEqualTypeOf<Promise<any>>();
			expectTypeOf<CommandBus>().toExtend<ICommandBus>();
		});

		it('rejects what is not a command, and handlers with the wrong result, at compile time', () => {
			// Never called: the calls below would fail at runtime too.
			const compileTimeOnly = (bus: CommandBus) => {
				// @ts-expect-error a string is not a command
				void bus.execute('open-account');
				// @ts-expect-error null is not a command
				void bus.execute(null);
				// @ts-expect-error the result of a typed command can't be retyped
				const _wrongResult: Promise<string> = bus.execute(new OpenAccountCommand());
				// @ts-expect-error a plain object is not a Command: the result brand is required, so it is not a weak type
				const _literal: CloseAccountCommand = { accountId: 'account-1' };

				// @ts-expect-error the decorator takes a class
				@CommandHandler('OpenAccountCommand')
				class _StringHandler {
					async execute() {}
				}

				// @ts-expect-error the handler resolves to a string, the command to an AccountId
				@CommandHandler(OpenAccountCommand)
				class _WrongResultHandler {
					async execute(_command: OpenAccountCommand): Promise<string> {
						return 'account-1';
					}
				}

				// @ts-expect-error a handler has an execute method
				@CommandHandler(OpenAccountCommand)
				class _NoExecuteHandler {}
			};

			expectTypeOf(compileTimeOnly).toBeFunction();
		});

		it('emits nothing for the result brand, so command payloads are unchanged', () => {
			const command = new OpenAccountCommand(['owner-1']);

			expect(Object.getOwnPropertySymbols(command)).toEqual([]);
			expect(Object.keys(command)).toEqual(['accountOwnerIds']);
			expect(JSON.stringify(command)).toBe('{"accountOwnerIds":["owner-1"]}');
			expect(Reflect.ownKeys(Command.prototype)).toEqual(['constructor']);
			expect(Reflect.ownKeys(new CloseAccountCommand('account-1'))).toEqual(['accountId']);
		});
	});

	describe('execute', () => {
		it('rejects, without throwing, when no handler is registered for the command', async () => {
			const bus = new CommandBus();
			const received: ICommand[] = [];
			const subscription = bus.subscribe((command) => received.push(command));

			let execution: Promise<unknown> | undefined;
			expect(() => {
				execution = bus.execute(new OpenAccountCommand());
			}).not.toThrow();

			await expect(execution).rejects.toBeInstanceOf(CommandHandlerNotFoundException);
			await expect(execution).rejects.toMatchObject({
				code: EventSourcingErrorCode.CommandHandlerNotFound,
				commandName: 'OpenAccountCommand',
			});
			subscription.unsubscribe();
			expect(received).toEqual([]);
		});

		it('rejects for a command class that no handler was ever declared for', async () => {
			// 3.x threw a MissingCommandMetadataException synchronously
			class UndeclaredCommand {}

			await expect(new CommandBus().execute(new UndeclaredCommand())).rejects.toMatchObject({
				code: EventSourcingErrorCode.CommandHandlerNotFound,
				commandName: 'UndeclaredCommand',
			});
		});

		it('rejects for a value without a class', async () => {
			const bus = new CommandBus();

			await expect(bus.execute(Object.create(null))).rejects.toBeInstanceOf(CommandHandlerNotFoundException);
			await expect(bus.execute(null as unknown as ICommand)).rejects.toBeInstanceOf(CommandHandlerNotFoundException);
			await expect(bus.execute('open-account' as unknown as ICommand)).rejects.toMatchObject({
				commandName: 'String',
			});
		});

		it('rejects with the error of a handler that throws synchronously', async () => {
			const bus = new CommandBus();
			const failure = new Error('handler failed');
			bus.bind(
				{
					execute: () => {
						throw failure;
					},
				},
				OpenAccountCommand,
			);

			let execution: Promise<unknown> | undefined;
			expect(() => {
				execution = bus.execute(new OpenAccountCommand());
			}).not.toThrow();
			await expect(execution).rejects.toBe(failure);
		});

		it('resolves to the value of a handler that returns synchronously', async () => {
			const bus = new CommandBus();
			bus.bind({ execute: (() => 'sync') as unknown as () => Promise<string> }, AddBookCommand);

			await expect(bus.execute(new AddBookCommand('dune'))).resolves.toBe('sync');
		});

		it('publishes the command before its handler runs', async () => {
			const bus = new CommandBus();
			const order: string[] = [];
			bus.bind(
				{
					execute: async () => {
						order.push('handled');
					},
				},
				CloseAccountCommand,
			);
			const subscription = bus.subscribe(() => order.push('published'));

			await bus.execute(new CloseAccountCommand('account-1'));
			subscription.unsubscribe();

			expect(order).toEqual(['published', 'handled']);
		});

		it('publishes through a replaced publisher', async () => {
			const bus = busWithHandlers();
			const published: ICommand[] = [];
			const publisher = { publish: (command: ICommand) => published.push(command) };
			bus.publisher = publisher;

			const command = new CloseAccountCommand('account-1');
			await bus.execute(command);

			expect(bus.publisher).toBe(publisher);
			expect(published).toEqual([command]);
		});
	});

	describe('handlers are keyed by class', () => {
		const namedClass = () =>
			class DuplicateCommand {
				readonly kind = 'duplicate';
			};

		it('routes classes with the same name to their own handlers', async () => {
			const First = namedClass();
			const Second = namedClass();
			const bus = new CommandBus();
			bus.bind({ execute: async () => 'first' }, First);
			bus.bind({ execute: async () => 'second' }, Second);

			expect(First.name).toBe(Second.name);
			await expect(bus.execute(new First())).resolves.toBe('first');
			await expect(bus.execute(new Second())).resolves.toBe('second');
		});

		it('does not route a subclass to the handler of its parent', async () => {
			class SpecialOpenAccountCommand extends OpenAccountCommand {}
			const bus = busWithHandlers();

			await expect(bus.execute(new SpecialOpenAccountCommand())).rejects.toMatchObject({
				code: EventSourcingErrorCode.CommandHandlerNotFound,
				commandName: 'SpecialOpenAccountCommand',
			});
		});

		it('routes a subclass with a handler of its own to that handler, and its parent to the parent handler', async () => {
			// 3.x gave the subclass the id it inherited from its parent, so both handlers shared one id
			class ParentCommand {}
			class ChildCommand extends ParentCommand {}
			@CommandHandler(ParentCommand)
			class ParentHandler {
				async execute() {
					return 'parent';
				}
			}
			@CommandHandler(ChildCommand)
			class ChildHandler {
				async execute() {
					return 'child';
				}
			}
			const bus = new CommandBus();
			bus.register([
				{ metatype: ParentHandler, instance: new ParentHandler() },
				{ metatype: ChildHandler, instance: new ChildHandler() },
			] as ProviderWrapper<ICommandHandler>[]);

			await expect(bus.execute(new ParentCommand())).resolves.toBe('parent');
			await expect(bus.execute(new ChildCommand())).resolves.toBe('child');
		});

		it('ignores the id metadata on the command class', async () => {
			const First = namedClass();
			const Second = namedClass();
			Reflect.defineMetadata(COMMAND_METADATA, { id: 'shared-id' }, First);
			Reflect.defineMetadata(COMMAND_METADATA, { id: 'shared-id' }, Second);
			const bus = new CommandBus();
			bus.bind({ execute: async () => 'first' }, First);

			await expect(bus.execute(new First())).resolves.toBe('first');
			await expect(bus.execute(new Second())).rejects.toBeInstanceOf(CommandHandlerNotFoundException);
		});

		it('keeps the handlers of two buses apart', async () => {
			const first = new CommandBus();
			const second = new CommandBus();
			first.bind({ execute: async () => 'first' }, AddBookCommand);
			second.bind({ execute: async () => 'second' }, AddBookCommand);

			await expect(first.execute(new AddBookCommand('dune'))).resolves.toBe('first');
			await expect(second.execute(new AddBookCommand('dune'))).resolves.toBe('second');
		});

		it('replaces the handler bound to a class before', async () => {
			const bus = new CommandBus();
			bus.bind({ execute: async () => 'old' }, AddBookCommand);
			bus.bind({ execute: async () => 'new' }, AddBookCommand);

			await expect(bus.execute(new AddBookCommand('dune'))).resolves.toBe('new');
		});
	});

	describe('register', () => {
		class HandlerWithoutMetadata {
			async execute() {
				return 'ok';
			}
		}

		it('throws when registering a handler without instance', () => {
			const bus = new CommandBus();
			const wrapper = { metatype: HandlerWithoutMetadata, instance: undefined } as unknown as ProviderWrapper;

			expect(() => bus.register([wrapper])).toThrow(InvalidCommandHandlerException);
		});

		it('throws when registering a handler without handler metadata', () => {
			const bus = new CommandBus();
			const wrapper = {
				metatype: HandlerWithoutMetadata,
				instance: new HandlerWithoutMetadata(),
			} as unknown as ProviderWrapper;

			expect(() => bus.register([wrapper])).toThrow(MissingCommandHandlerMetadataException);
		});

		it('registers a decorated handler for its command class', async () => {
			@CommandHandler(OpenAccountCommand)
			class OpenAccountCommandHandler implements ICommandHandler<OpenAccountCommand> {
				async execute({ accountOwnerIds }: OpenAccountCommand): Promise<AccountId> {
					return new AccountId(`account-of-${accountOwnerIds.join(',')}`);
				}
			}
			const bus = new CommandBus();
			bus.register([
				{ metatype: OpenAccountCommandHandler, instance: new OpenAccountCommandHandler() } as ProviderWrapper,
			]);

			await expect(bus.execute(new OpenAccountCommand(['owner-1']))).resolves.toEqual(
				new AccountId('account-of-owner-1'),
			);
		});

		it('registers a handler for a command class without id metadata', async () => {
			// 3.x threw a MissingCommandMetadataException: it routed by an id that @CommandHandler() stores on the class
			class CommandWithoutMetadata {}
			class HandlerForCommandWithoutMetadata {
				async execute() {
					return 'ok';
				}
			}
			Reflect.defineMetadata(
				COMMAND_HANDLER_METADATA,
				{ command: CommandWithoutMetadata },
				HandlerForCommandWithoutMetadata,
			);
			const bus = new CommandBus();
			bus.register([
				{
					metatype: HandlerForCommandWithoutMetadata,
					instance: new HandlerForCommandWithoutMetadata(),
				} as unknown as ProviderWrapper,
			]);

			await expect(bus.execute(new CommandWithoutMetadata())).resolves.toBe('ok');
		});
	});
});
