---
'@ocoda/event-sourcing': minor
'@ocoda/event-sourcing-mariadb': minor
---

**The MariaDB migration keeps 3.x streams whose ids differ in case only as one stream, and needs less work by hand.** The 3.x tables compared stream ids case-insensitively, so one 3.x stream could hold `account-Acc-1` version 1 and `account-acc-1` version 2. Schema v2 compares stream ids in binary, and the migration used to split such a stream into two, one of them starting at version 2.

- **One stream id per 3.x stream.** `MariaDBEventStore.migrate()` gives every row of such a stream the stream id of its lowest version (`account-Acc-1`), and a renamed row the aggregate id of that version when the two differ in case only. `MariaDBSnapshotStore.migrate()` gives every snapshot stream the stream id of its events, from the pool's 3.x event table or its `__es_v1` backup, or else the id of its lowest snapshot. It is deterministic, and a rerun after a crash ends in the same state. **After the migration, use those stream ids**: 4.0 reads `account-acc-1` as another, empty stream. Keep the events' backups (the default) until the snapshots are migrated.
- **The report lists them.** A new `canonicalizedStreams: { total, rows, sample }` on `MigrationCollectionReport` gives, per stream, the id it takes, the ids it replaces and the rows that change (a sample of up to 1,000 streams), in the dry run and in the migration's report, with a warning that shows a few. `caseVariantStreams` now also counts snapshot streams. `gappedStreams` and `snapshotFlags` count a 3.x stream once, so a case-variant stream no longer shows up as gapped.
- **A missing privilege fails before the copy.** The event migration renames the empty copy and back (`probe-swap`), which needs the swap's privileges, so a user without `ALTER` fails there instead of at the swap after the whole copy. The dry run still can't check privileges.
- **Lock waits name the sessions.** With the `PROCESS` privilege, a step that times out on a lock lists the sessions with an open transaction (`KILL <id>` ends one).
- **Galera.** The migration replicates in fragments of 64 MiB, or of half the node's `wsrep_max_ws_size` when that is smaller, so it no longer fails on a smaller `wsrep_max_ws_size`.
- **Dropping the backups** needs no SQL: run `MariaDBEventStore.migrate(config, { keepBackup: false })` again, after the snapshots are migrated. When `keepBackup: false` would drop the backup of a pool whose snapshot table isn't migrated yet, the dry run and the report warn about it.
- `migrations/4.0.sql` has the new statements, and suggests dropping the events' backup only after the snapshots.
