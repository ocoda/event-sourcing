---
'@ocoda/event-sourcing': major
---

**Typed command and query buses.** `commandBus.execute()` and `queryBus.execute()` take their result type from the command or query, route by class, and reject instead of throwing. See the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#typed-buses).

- **`Command<TResult>` and `Query<TResult>`** are new base classes. For `OpenAccountCommand extends Command<AccountId>`, `commandBus.execute(new OpenAccountCommand())` resolves to an `AccountId` without a type argument, `ICommandHandler<OpenAccountCommand>` resolves to it, and `@CommandHandler(OpenAccountCommand)` rejects a handler that resolves to something else. `Command` without a type argument is `Command<void>`. The classes add no property, so payloads are unchanged. `ResultOf<T>` is the result type of a command or query class.
- **3.x commands and queries keep compiling.** A plain class still works as a command or query, and `execute()` resolves to `any` for it. `execute<AddBookCommand>(command)` and `execute<OpenAccountCommand, AccountId>(command)` compile unchanged. The result type is no longer inferred from the variable it is assigned to.
- **TypeScript 5.4 or later.** The declarations of `execute()` use `NoInfer`, so an older compiler reports `Cannot find name 'NoInfer'`, or, with `skipLibCheck`, types every result as `any`.
- **`ICommand` and `IQuery` are `object`** instead of `any`: a primitive, `null`, `undefined`, a value typed `unknown` or an unconstrained type parameter no longer type-checks as a command or query.
- **`execute()` always returns a promise.** A command or query without a handler rejects with a `CommandHandlerNotFoundException` or `QueryHandlerNotFoundException` (it threw synchronously) and publishes nothing. A handler that throws synchronously rejects too.
- **Handlers are registered by class**, not by an id stored on the class. A command or query reaches the handler of its class or, if there is none, of its nearest parent class, so a subclass without a handler of its own still reaches its parent's. A subclass with a handler of its own now reaches it: in 3.x it inherited its parent's id, and the handler registered last handled both classes. A class without any handler rejects with the not-found exception instead of throwing `MissingCommandMetadataException` or `MissingQueryMetadataException`. Those exceptions, `getCommandMetadata()`, `getQueryMetadata()`, `CommandMetadata` and `QueryMetadata` are deprecated and will be removed in 5.0. `bind(handler, command)` on the buses takes the class instead of the id.
- **The decorators take classes.** `@CommandHandler()`, `@QueryHandler()`, `@EventSubscriber()` and `@EventSerializer()` no longer accept other values, and the class passed to them needs a public constructor. `@CommandHandler()` and `@QueryHandler()` require the decorated class to have an `execute()` that returns a promise, and return a decorator typed for the handler class instead of a `ClassDecorator`: to compose them with `applyDecorators()` under `strictFunctionTypes`, cast them (`CommandHandler(OpenAccountCommand) as ClassDecorator`), which skips the check of the result type.
- `execute()` takes an optional `{ request }` argument, reserved for request-scoped handlers. It is ignored until they arrive in a later prerelease.

**Migration**

1. Assert a missing handler as a rejection: `await expect(commandBus.execute(command)).rejects.toThrow(CommandHandlerNotFoundException)`.
2. Catch `CommandHandlerNotFoundException` and `QueryHandlerNotFoundException` where you caught `MissingCommandMetadataException` and `MissingQueryMetadataException`.
3. Where a command or query class and its subclass both have a handler, check that each handler expects only its own class.
4. Make the `execute()` of every decorated handler return a promise, for example by making it `async`.
5. Constrain the type parameters you pass to `execute()` (`<C extends ICommand>`), make the constructors of command and query classes public, and cast the handler decorators you pass to `applyDecorators()`.
6. Optionally, extend `Command<TResult>` and `Query<TResult>` (constructors call `super()`) and drop the type arguments of `execute()`.
