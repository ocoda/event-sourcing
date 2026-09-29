# Testing Fixtures

This package includes fixtures for unit and E2E test suites across the monorepo.

## Store Conformance Suites

`@ocoda/event-sourcing-testing/conformance` holds the contract that every event store and snapshot store has to
satisfy, whatever the database behind it. Every store in this repository runs it from a
`*.conformance.spec.ts` file, next to its own specs.

```ts
import { describeEventStoreConformance } from '@ocoda/event-sourcing-testing/conformance';

describeEventStoreConformance(
	PostgresEventStore.name,
	async (eventMap) => {
		const store = new PostgresEventStore(eventMap, { driver: undefined as never, ...connectionOptions });
		await store.connect();

		return {
			store,
			// Drop the collections the suite created (some may not exist) and disconnect
			cleanup: async (collections) => { /* ... */ },
		};
	},
	{
		skip: {
			// A case the store doesn't satisfy yet, with the reason. It is reported as skipped.
			'occurred-on-milliseconds': 'occurred_on is a TIMESTAMP(0) column, which drops the milliseconds',
		},
	},
);
```

`describeSnapshotStoreConformance(name, factory, options)` works the same way; its factory takes no event map.

- The suites create their own pools, named after `options.pool`, which defaults to a name unique to the run. Parallel
  runs and leftovers of earlier runs therefore can't affect the results.
- They cover appends and reads with every filter (`fromVersion`, `direction`, `limit`, `batch`), version conflicts
  (stale, overlapping and concurrent appends, with the exact exception class), not-found errors, unknown pools,
  `ensureCollection` and `listCollections`, `getAllEnvelopes` month ranges, consumers that stop early or throw, payload
  fidelity, and for snapshots the bulk reads and the latest snapshots of an aggregate.
- The case ids are listed in `EVENT_STORE_CONFORMANCE_CASES` and `SNAPSHOT_STORE_CONFORMANCE_CASES`. Only skip a case
  with a reason and a TODO in the spec. Run with `CONFORMANCE_RUN_SKIPPED=true` to check whether a skip is still needed,
  e.g. `CONFORMANCE_RUN_SKIPPED=true pnpm test --filter=@ocoda/event-sourcing-postgres`. `turbo.json` declares the
  variable on the `test` and `test:cov` tasks, so turbo passes it on and doesn't replay a result cached without it.
- A case can also be gated on a capability of the store (`conformanceTest(...)(id, title, fn, { requires })`). It is
  then reported as skipped with `capability: <flag>`; `CONFORMANCE_RUN_SKIPPED` doesn't lift such a gate, because a
  store that doesn't claim a guarantee isn't expected to give it.
- `CONFORMANCE_REPEAT=n` runs every case n times, to soak out flaky concurrency, e.g.
  `CONFORMANCE_REPEAT=20 pnpm --filter @ocoda/event-sourcing exec vitest run tests/unit/integration/event-store/in-memory.event-store.conformance.spec.ts`.
  `turbo.json` doesn't declare it yet, so `pnpm test` (turbo) drops it and runs every case once: run it through
  `pnpm --filter … exec vitest` as above.

## Cross-Version Suite

`@ocoda/event-sourcing-testing/cross-version` holds what the drivers' `tests/cross-version` specs need to check that
they read data the published 3.0.2 packages wrote. `pnpm test:cross-version --database <db>`
(`scripts/test-cross-version.mjs`) runs the 3.0.2 writer in `fixtures/cross-version/v3`, which records what 3.0.2 read
back in a manifest, then runs the specs with `vitest.cross-version.mts` (they are excluded from `test` and `test:cov`).

- `loadCrossVersionManifest()` reads the manifest (`XV_MANIFEST`); `CrossVersionManifest` documents it.
- `domain.ts` mirrors the writer's events and aggregates, `createCrossVersionEventMap()` registers them.
- `encodeValue` turns a value into JSON that keeps classes, `Date`s and `undefined`, the same way the writer does, so
  a read compares with `toEqual` against the manifest.
- `expectEventStreamReads`, `expectLegacyAllOrder`, `expectSnapshotStreamReads` and `expectListedCollections` are the
  assertions; each driver's spec composes them and can replace one when its schema changes.
- `tests/cross-version/cross-version.json` says whether a 3.0.2 append after the read must succeed (the 3.x schema) or
  fail (schema v2 fences 3.x writers).

## Banking Production Event Suite

`@ocoda/event-sourcing-testing` exposes a production-style banking event suite that models a realistic
customer lifecycle with multiple accounts, card activity, transfers, disputes, and compliance checks.

### Usage

```ts
import { createBankingProductionScenario } from '@ocoda/event-sourcing-testing/e2e';

const scenario = createBankingProductionScenario();

// Inspect all events or feed into a store
for (const event of scenario.allEvents) {
  console.log(event.event, event.metadata.aggregateId);
}
```

### Scenario Coverage

- Customer onboarding, KYC, and risk lifecycle
- Checking and savings account activity
- Transfers (internal + ACH) including failure/reversal
- Card auth, capture, refund activity
- Dispute/chargeback flow
- Fraud holds and compliance review

### Notes

- All events are deterministic and timestamped.
- Streams are grouped by aggregate with sequential versions.
- Correlation IDs are used for transfer and dispute flows.
