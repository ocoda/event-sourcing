---
'@ocoda/event-sourcing': patch
---

Fix reliability issues in the core package:

- **Event subscribers are isolated.** Before this fix, if an `@EventSubscriber` threw or returned a rejected promise, that subscriber was unsubscribed for good and the error was rethrown as an uncaught exception, which crashed the process. Now the error is logged (logger context `EventBus`, with the event and subscriber name). The subscriber keeps receiving later events, and other subscribers are unaffected.
- **Publishing can no longer fail an append after the events are persisted.** If an `@EventPublisher` throws or rejects (async publishers were never awaited, so a rejection crashed the process), the error is now logged. The remaining publishers and envelopes are still published, and `appendEvents` resolves.
- **Appending before bootstrap no longer throws.** When `appendEvents` runs before the application is bootstrapped (for example in an `onModuleInit` seeder), the events are persisted and returned but not published. A single warning is logged. Before, the append threw a `TypeError` after the events had already been persisted.
- **`EventSourcingModule.forRootAsync({ useClass })` works.** The options factory class is now registered as a provider. `forRootAsync()` also throws a descriptive error when none of `useFactory`, `useClass`, `useExisting` or `useValue` is given.
- **In-memory stores.** `ensureCollection()` only creates missing pools and no longer wipes an existing pool's events or snapshots. `disconnect()` no longer throws when the store was never connected. `InMemorySnapshotStore.getLastEnvelopesForAggregate` now pages correctly: results stay filtered by aggregate and sorted in descending stream order, and `aggregateId` works as an exclusive "after" cursor, so pages don't overlap.
- **Snapshots are no longer skipped when a save jumps over an interval boundary** (for example from v9 to v11 with interval 10). `SnapshotRepository.save` uses the versions recorded by the aggregate's last `commit()`. It takes a snapshot when those committed events cross an interval boundary or the first version, so a new aggregate created with several events now gets its first snapshot. When the committed versions are unknown, the previous rule applies (version 1 and multiples of the interval).
- **Subscribing to a bus now emits values.** `eventBus.pipe(...)` and `commandBus.subscribe(...)` used to produce nothing. Now they receive the published envelopes, commands and queries, as they do in `@nestjs/cqrs`. `subject$` keeps working.
- **The default `until` month of `getAllEnvelopes` is computed in UTC,** so events of the current UTC month are no longer missed in timezones behind UTC.
- **`InMemoryEventStore` and `InMemorySnapshotStore` are exported from the package root,** together with their config and entity types.
