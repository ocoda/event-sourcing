/**
 * The id that `@QueryHandler()` stores on a query class.
 *
 * @deprecated The `QueryBus` keys its handlers by class and no longer reads it. Removed in 5.0.
 */
export interface QueryMetadata {
	id: string;
}
