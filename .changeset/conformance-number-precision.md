---
'@ocoda/event-sourcing': minor
---

**`@ocoda/event-sourcing/testing`: new conformance case `payload-number-precision`.** The event store and snapshot store suites now check that a payload's doubles come back with all their significant digits, for example `0.1 + 0.2` (`0.30000000000000004`), `Number.MAX_VALUE` and a 17-digit `123456789.12345679`. The existing `payload-json-fidelity` case only holds short decimals, so it passed for a store that parses or prints JSON numbers with less precision and changes the last digit. All built-in stores pass the new case.

A custom store that runs the suites may now fail this case. Store the payload as JSON text or as binary doubles, and print numbers with the shortest round-trip representation (what `JSON.stringify` does). Until the store is fixed, skip the case with its reason: `skip: { 'payload-number-precision': '<why>' }`.
