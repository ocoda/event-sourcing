---
'@ocoda/event-sourcing-mariadb': patch
---

**`globalOrder: 'gap-safe'` only on one InnoDB server.** `MariaDBEventStore` claimed `'gap-safe'` on every server except a Galera node. It now also reports `'best-effort'` on a MySQL Group Replication member in multi-primary mode, on TiDB and on Vitess (PlanetScale). There the counter row's lock doesn't order the commits of the whole deployment. On Vitess with any `transaction_mode` other than `SINGLE` or `TWOPC` (`MULTI` is the default), it also reports `atomicAppend: false`, because the counter and the events can sit on different shards. `connect()` tells these apart by system variables that only they have (`@@tidb_txn_mode`, `@@transaction_mode`, `@@group_replication_single_primary_mode`), and logs one warning per process and kind. The Galera warning is now logged once per process too, instead of on every connect. MariaDB, MySQL, a single-primary Group Replication group and Amazon Aurora keep `'gap-safe'`.

- **Galera, precisely.** A Galera node is now one with `wsrep_on` on *and* a provider loaded. A standalone MariaDB server started with `wsrep_on=ON` and no provider (`wsrep_provider=none`) reads `@@wsrep_on = 1` too. It was taken for a Galera node, reported `'best-effort'`, and `migrate()` set Galera's session options on it. It now keeps `'gap-safe'`.
- **TiDB.** `readAll` reads the high-water mark without `LOCK IN SHARE MODE`, which TiDB refuses (1235), so it no longer throws at a gap.
- **Group Replication conflicts.** A `COMMIT` that Group Replication refuses (3101, a conflict with another member) is now a `'not-persisted'` outcome, like a deadlock: the transaction was rolled back. `appendSnapshot` runs again after one, as it does after a deadlock.
