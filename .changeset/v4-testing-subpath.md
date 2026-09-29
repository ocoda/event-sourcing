---
'@ocoda/event-sourcing': minor
---

**`@ocoda/event-sourcing/testing`: the store conformance suites are published.** A custom event store or snapshot store can now run the suites that every built-in store runs, and prove it implements the 4.0 store contract. See [Test your Event Store](https://ocoda.github.io/event-sourcing/advanced/custom-stores#test-your-event-store) and the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#custom-store-conformance).

```ts
import { describeEventStoreConformance, describeSnapshotStoreConformance } from '@ocoda/event-sourcing/testing';

describeEventStoreConformance('FooEventStore', async (context) => {
	const store = new FooEventStore(context, { ... });
	await store.connect();
	return { store, cleanup: async (collections) => { /* drop them, then disconnect */ } };
});
```

- **Vitest.** The suites register [Vitest](https://vitest.dev) tests. `vitest` (`^4.0.0 || ^5.0.0`) is an optional peer dependency of `@ocoda/event-sourcing`: install it to use the subpath. The suites import Vitest's API, so they run without `globals: true`, and the root entry point never loads Vitest. npm checks an optional peer whenever the project has that package, so a project on another major of Vitest gets `ERESOLVE` from `npm install` until it moves to Vitest 4 or 5 or installs with `--legacy-peer-deps`; pnpm and Yarn only warn. TypeScript resolves the subpath through `exports`, so it needs the `node16`, `nodenext` or `bundler` `moduleResolution`.
- **What the subpath exports.** `describeEventStoreConformance(name, (context) => handle, options)` and `describeSnapshotStoreConformance(name, () => handle, options)`, the case ids (`EVENT_STORE_CONFORMANCE_CASES`, `SNAPSHOT_STORE_CONFORMANCE_CASES`) and the handle types (`EventStoreConformanceHandle`, `SnapshotStoreConformanceHandle`); the `RecordingPublisher`, which records what a store publishes; and helpers for tests on the in-memory stores: `createTestEventStoreContext({ events })`, `createInMemoryEventStore({ events })` and `createInMemorySnapshotStore()`.
- **Capabilities gate cases.** A case that needs a capability the store doesn't claim is skipped with `capability: <flag>`, and `skip` takes the remaining gaps, each with a reason. A snapshot store that keeps the base class's `getLastEnvelopesForAggregate`, which rejects every read with an `UnsupportedOperationException`, skips the cases of that read the same way.
- `CONFORMANCE_RUN_SKIPPED=true` runs the skipped cases, and `CONFORMANCE_REPEAT=n` runs every case n times.
