---
"@ocoda/event-sourcing-mariadb": patch
"@ocoda/event-sourcing-mongodb": patch
---

Harden the MariaDB and MongoDB event and snapshot stores.

MariaDB:

- Reads no longer hide failures. A missing table, a dropped connection or an unregistered event used to end the stream silently and return a truncated history. The original error is now thrown to the consumer. Applications that relied on reading a not-yet-created pool returning nothing must create it with `ensureCollection()` first.
- Stopping a read early (`break` or an error in the consumer) now discards the rest of the result set and releases the connection. Before, this could leave the connection stuck and eventually exhaust the pool.
- A concurrent append that loses the race on the primary key now throws `EventStoreVersionConflictException` / `SnapshotStoreVersionConflictException` instead of `EventStorePersistenceException` / `SnapshotStorePersistenceException`.
- Table names are quoted with the connector's `escapeId`, so pool names with special characters are handled safely.

MongoDB:

- Cursors are now closed when a read ends early or fails, instead of staying open on the server until they time out.
- Appends no longer look up the collection on every write. Collections that are known to exist (created through `ensureCollection()` or found once) are remembered per store instance. Unknown pools are still rejected with the same exception and are checked against the server on every attempt. If you drop a collection while a store instance is running, call `ensureCollection()` again before appending to it: otherwise MongoDB re-creates it on the next write without its unique indexes.
- A concurrent append that loses the race on the `(streamId, version)` unique index now throws `EventStoreVersionConflictException` / `SnapshotStoreVersionConflictException` instead of `EventStorePersistenceException` / `SnapshotStorePersistenceException`. Events of the losing append that were already inserted are removed again.
- The batches yielded by the read methods are no longer emptied after the consumer resumes, so consumers can safely keep a reference to a batch.
