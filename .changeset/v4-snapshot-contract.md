---
'@ocoda/event-sourcing': major
---

**The snapshot store API is Promise-only, and the in-memory snapshot store pages `loadAll` in binary order.** This is the 4.0 snapshot store contract of ADR 0001. The PostgreSQL, MariaDB and MongoDB snapshot stores already return promises; their cursor, order and single latest snapshot follow with their schema v2 in a later prerelease.

- **Every method of `SnapshotStore` returns a promise** (or an async generator), and a failure is a rejection. The in-memory store's `getSnapshot`, `getEnvelope`, `getLastSnapshot`, `getLastSnapshots`, `getLastEnvelope` and `getManyLastSnapshotEnvelopes` returned their result directly and threw synchronously, for example a `SnapshotNotFoundException`. They now have to be awaited. `SnapshotRepository` already awaited them.
- **`getEnvelope` and `getEnvelopes` are required** (they were optional). `getManyLastSnapshotEnvelopes` and `getLastEnvelopesForAggregate` have defaults in the base class: the first reads the streams one by one with `getLastEnvelope`, so `SnapshotRepository.loadMany()` works with every store; the second rejects with an `UnsupportedOperationException` when it's read, which `loadAll()` passes on.
- **`SnapshotStoreDriver` is now the class of a store**, `new (options) => SnapshotStore`, and `SnapshotStoreConfig.driver` has that type. It used to be an interface for a store instance.
- **In-memory store:** the last snapshot of a stream is the one with the highest version, and `getLastEnvelopesForAggregate` (so `loadAll`) orders the streams in descending binary order of their aggregate ids, case-sensitively, with `aggregateId` as an exclusive cursor. It used to compare the ids ignoring case, so a page could skip a stream whose id differed from the cursor in case only.

**Migration**

1. Await the reads of an `InMemorySnapshotStore` that you call directly, and catch their failures as rejections:

   ```ts
   // 3.x
   const snapshot = snapshotStore.getSnapshot(stream, 10);
   // 4.0
   const snapshot = await snapshotStore.getSnapshot(stream, 10);
   ```

2. In a custom snapshot store, make every method `async`, implement `getEnvelope` and `getEnvelopes`, and drop a `getManyLastSnapshotEnvelopes` that only loops over `getLastEnvelope`. An implementation of `getLastEnvelopesForAggregate` orders by aggregate id in descending binary order and treats `filter.aggregateId` as an exclusive cursor.
3. Type store instances as `SnapshotStore` instead of `SnapshotStoreDriver`.
4. If you page through `loadAll()` on the in-memory store with mixed-case aggregate ids, expect uppercase ids to come after lowercase ones.
