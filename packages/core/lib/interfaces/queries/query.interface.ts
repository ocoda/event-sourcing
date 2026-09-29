/**
 * A query: any object. Extend `Query<TResult>` to type the result of executing it.
 *
 * It was `any` in 3.x, so primitives, `null` and `undefined` no longer type-check as queries.
 */
export type IQuery = object;
