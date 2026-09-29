---
'@ocoda/event-sourcing-mariadb': patch
---

Fix two reads of the MariaDB snapshot store.

- `getLastSnapshots([])` and `getManyLastSnapshotEnvelopes([])`, and so `SnapshotRepository.loadMany([])`, return an empty map instead of failing with an SQL syntax error.
- `getLastEnvelopesForAggregate`, and so `SnapshotRepository.loadAll`, returns the streams in descending order of their stream id, like the other stores. The query had no `ORDER BY`, so MariaDB returned them in index order, which in practice was ascending.
  **Behaviour change:** on MariaDB, the order of `loadAll` is reversed, and a `limit` now returns the streams with the highest stream ids instead of the lowest. If you relied on the old order, sort the results yourself.
