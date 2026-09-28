---
'@ocoda/event-sourcing-dynamodb': patch
---

Fix silent data loss in the DynamoDB event and snapshot stores.

- `appendEvents` now writes all events of a call in a single conditional `TransactWriteItems` transaction instead of an unconditional `BatchWriteItem`. Events are stored all-or-nothing, an existing version is never overwritten (including the first event of a stream), and a writer that loses a race gets an `EventStoreVersionConflictException` instead of silently overwriting events. Appends of more than 25 events now work, but DynamoDB limits a transaction to 100 items and 4 MB in total: appending more than 100 events in one call is rejected with an `EventStorePersistenceException` before anything is written. Transactional writes consume twice the write capacity units of regular writes, which matters for tables in provisioned capacity mode.
- `appendSnapshot` uses conditional transactional writes as well: an existing snapshot version is never overwritten, the `latest` marker is moved atomically, and conflicts raise a `SnapshotStoreVersionConflictException`.
- Stream reads and the version checks before appends are strongly consistent (`ConsistentRead`), which consumes twice the read capacity of eventually consistent reads.
- `Date` values in event and snapshot payloads are now stored as ISO-8601 strings, like the SQL stores do. Earlier versions stored them as empty maps, so Date values written by earlier versions are lost and cannot be recovered.
- `ensureCollection` only sends `ProvisionedThroughput` in `PROVISIONED` billing mode (and then also for the table's global secondary index), as real AWS requires, waits until a newly created table is `ACTIVE`, and tolerates the table being created concurrently. Table creation errors are now wrapped in an `EventStoreCollectionCreationException` / `SnapshotStoreCollectionCreationException`.
