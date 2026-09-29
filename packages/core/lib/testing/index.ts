// @ocoda/event-sourcing/testing: the conformance suites that every event store and snapshot store runs, and helpers
// for tests on the in-memory stores. The suites register Vitest tests with the imported Vitest API (no globals), so
// this entry point needs vitest, an optional peer dependency of @ocoda/event-sourcing. The root entry point never
// imports it.
export {
	type ConformanceEventStore,
	EVENT_STORE_CONFORMANCE_CASES,
	type EventStoreConformanceCase,
	type EventStoreConformanceFactory,
	type EventStoreConformanceOptions,
	describeEventStoreConformance,
} from './event-store.conformance.js';
export * from './in-memory.js';
export * from './recording-publisher.js';
export {
	type ConformanceSnapshotStore,
	SNAPSHOT_STORE_CONFORMANCE_CASES,
	type SnapshotStoreConformanceCase,
	type SnapshotStoreConformanceFactory,
	type SnapshotStoreConformanceOptions,
	describeSnapshotStoreConformance,
} from './snapshot-store.conformance.js';
export * from './types.js';
