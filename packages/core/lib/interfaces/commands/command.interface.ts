/**
 * A command: any object. Extend `Command<TResult>` to type the result of executing it.
 *
 * It was `any` in 3.x, so primitives, `null` and `undefined` no longer type-check as commands.
 */
export type ICommand = object;
