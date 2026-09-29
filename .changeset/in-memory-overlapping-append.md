---
'@ocoda/event-sourcing': patch
---

`InMemoryEventStore.appendEvents` now rejects an append whose first version already exists with an `EventStoreVersionConflictException`. Before, appending two events at version 4 to a stream at version 3 stored a second event with version 3. The database stores already reject this through their unique (stream, version) key.
