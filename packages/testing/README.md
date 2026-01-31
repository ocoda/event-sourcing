# Testing Fixtures

This package includes fixtures for unit and E2E test suites across the monorepo.

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
