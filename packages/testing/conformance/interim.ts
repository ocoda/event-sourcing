// INTERIM(H): removed with the interim legacy path, once every built-in store implements the store contract.
import type { EventStoreConformanceCase } from './event-store.conformance.js';

const REASON = 'interim legacy driver: native contract lands with schema v2';

/**
 * The cases that a store that still overrides `appendEvents` (the interim legacy path of the built-in database stores)
 * can't pass: they need `getStreamVersion`, `persistEvents`, `readAll`, global positions, `ExpectedVersion.Any`,
 * append metadata, or the checks of the base class's `appendEvents`. The database stores spread this into their
 * `skip` until they implement the contract with schema v2.
 */
export const LEGACY_DRIVER_SKIPS: Readonly<Partial<Record<EventStoreConformanceCase, string>>> = Object.freeze({
	'append-envelope-preserved': REASON,
	'append-deprecated-positional': REASON,
	'append-atomic-partial-failure': REASON,
	'expected-exact': REASON,
	'expected-gap': REASON,
	'conflict-fields': REASON,
	'concurrent-any': REASON,
	'unknown-pool-append': REASON,
	'unknown-pool-read': REASON,
	'template-not-overridden': REASON,
	'publish-committed-once': REASON,
	'metadata-round-trip': REASON,
	'read-all-order': REASON,
	'read-all-positions-on-reads': REASON,
	'read-all-resume': REASON,
	'read-all-gap-safe': REASON,
	'read-all-best-effort': REASON,
	'read-all-early-break': REASON,
	'read-all-consumer-throws': REASON,
});
