---
'@ocoda/event-sourcing-mariadb': patch
---

Fix two reads of the MariaDB snapshot store.

- `getLastSnapshots([])` and `getManyLastSnapshotEnvelopes([])`, and so `SnapshotRepository.loadMany([])`, return an empty map instead of failing with an SQL syntax error.
- `getLastEnvelopesForAggregate`, and so `SnapshotRepository.loadAll`, returns the streams in descending order of their stream id, like the other stores. The query had no `ORDER BY`, so the order, and which streams a `limit` returned, depended on the database.
