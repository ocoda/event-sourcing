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
	// The suite hands over the store context: the conformance event map and a RecordingPublisher
	async (context) => {
		const store = new PostgresEventStore(context, { driver: undefined as never, ...connectionOptions });
		await store.connect();

		return {
			store,
			// Drop the collections the suite created (some may not exist), their catalog rows, and disconnect
			cleanup: async (collections) => { /* ... */ },
			// Optional: make inserts of an event fail from inside the database, for append-atomic-partial-failure
			faults: { failInsertOf: async (collection, eventName) => async () => { /* remove the fault */ } },
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

`describeSnapshotStoreConformance(name, factory, options)` works the same way; its factory takes no context.

- The event store suite covers the v4 store contract (ADR 0001 §1, §8 and §9): expected versions, `ExpectedVersion.Any`,
  pre-built envelopes, validation without I/O, publishing, metadata and headers, global positions and `readAll`. It reads
  the capabilities of the store once the factory resolved, and skips the cases of a capability the store doesn't claim.
- `LEGACY_DRIVER_SKIPS` (interim, removed with the finalize PR) lists the cases that a store which still overrides
  `appendEvents` can't pass; the database stores spread it into their `skip` until they move to schema v2. The readAll
  parts of `envelope-metadata-round-trip` and `conflict-concurrent-appends` are skipped along with `read-all-order`.
- `{ only, expectFailure: true }` registers selected cases as tests that must fail, for negative controls: deliberately
  broken stores that prove a case detects its defect (`packages/core/tests/unit/conformance/negative-controls.spec.ts`).

- The suites create their own pools, named after `options.pool`, which defaults to a name unique to the run. Parallel
  runs and leftovers of earlier runs therefore can't affect the results.
- They cover appends and reads with every filter (`fromVersion`, `direction`, `limit`, `batch`), version conflicts
  (stale, overlapping and concurrent appends, with the exact exception class), not-found errors, unknown pools,
  `ensureCollection` and `listCollections`, `readAll`, consumers that stop early or throw, payload
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
