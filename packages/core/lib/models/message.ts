/**
 * The brand that carries the result type of a command or query. It exists only in the types: `declare` emits no
 * field, so instances and their payloads are unchanged.
 */
declare const RESULT: unique symbol;

/**
 * Base class for a command whose handler resolves to `TResult`. `commandBus.execute(new OpenAccountCommand())`
 * then resolves to `TResult` without a type argument, and `@CommandHandler(OpenAccountCommand)` only accepts a
 * handler whose `execute` resolves to it.
 *
 * Extending it is optional: any class works as a command, and the bus resolves to `any` for one that doesn't.
 *
 * @example
 * ```ts
 * export class OpenAccountCommand extends Command<AccountId> {
 * 	constructor(public readonly accountOwnerIds?: string[]) {
 * 		super();
 * 	}
 * }
 * ```
 */
export abstract class Command<TResult = void> {
	// Non-optional, so a command class is not a weak type that any object would match.
	declare readonly [RESULT]: TResult;
}

/**
 * Base class for a query whose handler resolves to `TResult`. `queryBus.execute(new GetAccountQuery(id))` then
 * resolves to `TResult` without a type argument, and `@QueryHandler(GetAccountQuery)` only accepts a handler
 * whose `execute` resolves to it.
 *
 * Extending it is optional: any class works as a query, and the bus resolves to `any` for one that doesn't.
 */
export abstract class Query<TResult> {
	// Non-optional, so a query class is not a weak type that any object would match.
	declare readonly [RESULT]: TResult;
}

/**
 * The result type of a command or query: `TResult` for a `Command<TResult>` or `Query<TResult>`, `any` for a plain
 * class, as in 3.x.
 */
export type ResultOf<T> = T extends { readonly [RESULT]: infer R } ? R : any;
