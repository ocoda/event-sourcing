/**
 * The optional guarantees of an event store. The conformance suite tests every guarantee a store claims.
 *
 * Every flag is optional: `resolveCapabilities()` fills the missing ones with `DEFAULT_EVENT_STORE_CAPABILITIES`.
 */
export interface EventStoreCapabilities {
	/**
	 * An append stores all of its events or none of them.
	 * @default true
	 */
	atomicAppend?: boolean;
	/**
	 * The store persists the `headers` of the events. A store without it rejects an append that carries headers.
	 * @default false
	 */
	headers?: boolean;
	/**
	 * What the global positions that `readAll` yields a pool in guarantee.
	 * - `'gap-safe'`: positions strictly increase, and once a position was read, no event at or below it commits later.
	 * - `'best-effort'`: positions strictly increase, but an event may still commit below a position that was read.
	 * @default 'best-effort'
	 */
	globalOrder?: 'gap-safe' | 'best-effort';
}
