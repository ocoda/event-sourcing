---
'@ocoda/event-sourcing-mariadb': patch
---

`getLastSnapshots([])` and `getManyLastSnapshotEnvelopes([])` of the MariaDB snapshot store, and so `SnapshotRepository.loadMany([])`, return an empty map instead of failing with an SQL syntax error.
