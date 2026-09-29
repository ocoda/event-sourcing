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
  with a reason and a TODO in the spec. Run with `CONFORMANCE_RUN_SKIPPED=true` to check whether a skip is still needed.

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
