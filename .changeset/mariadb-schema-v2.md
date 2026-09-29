---
'@ocoda/event-sourcing-mariadb': major
---

**MariaDB schema v2: the MariaDB stores implement the 4.0 store contract.** `MariaDBEventStore` stores global positions, metadata and headers and reads all events with `readAll`; `MariaDBSnapshotStore` keeps one latest snapshot per stream. Tables created by 3.x must be migrated once with `migrate()`. See [MariaDB](https://ocoda.github.io/event-sourcing/integrations/mariadb) and the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#mariadb-schema-v2).

- **Event store.** The options form of `appendEvents` with `ExpectedVersion.Any`, `correlationId`, `causationId` and `headers`, and `readAll({ fromPosition, batch, pool })` with a `globalPosition` per pool from `1n`. Capabilities: `{ atomicAppend: true, headers: true, globalOrder: 'gap-safe' }` on InnoDB, `'best-effort'` on a Galera cluster. `getAllEnvelopes` throws an `UnsupportedOperationException`: use `readAll`. Appends run in `READ COMMITTED` and take their positions from a counter per pool, so the appends to one pool are serialized; use pools to scale writes. The stores' sessions run in `READ COMMITTED` (added after your `initSql`), and `readAll` must read from the server the appends run on, not from a replica behind a read/write-splitting proxy.
- **Schema v2.** Event tables gain `global_position`, `headers` and `event_version` and lose `event_date`; `occurred_on` and `registered_on` are `DATETIME(3)` in UTC (milliseconds, independent of the application's time zone); text compares in binary (`utf8mb4_bin`), so **stream ids are case-sensitive**; ids and names can be up to 255 characters. A catalog table, `event_sourcing_collections`, registers every table and holds the position counters; `listCollections()` reads it.
- **3.x event tables are refused** by `ensureCollection()` with an `EventStoreSchemaException` (`found: 'v1'`), so an application whose default pool has one fails its bootstrap until it is migrated. Reads of a pool without a table throw an `EventCollectionNotFoundException`; appends to it an `EventStorePersistenceException` with `outcome: 'not-persisted'`.
- **`ddl: 'auto' | 'none'`.** `'none'` never creates or alters tables: `ensureCollection()` checks and registers them, and reports the statements to run.
- **Snapshots.** The last snapshot of a stream is its highest version, a unique key allows one latest snapshot per stream also when appends race, and `getLastEnvelopesForAggregate` (`loadAll`) pages in descending binary order with an exclusive `aggregateId` cursor. A 3.x snapshot table keeps working, with a warning, until it is migrated.
- **`migrate()`.** `MariaDBEventStore.migrate(config, options)` and `MariaDBSnapshotStore.migrate(config, options)` (static, no NestJS application needed; also on a connected store) migrate the 3.x tables, with a `dryRun` that writes nothing and reports the exact statements, gapped streams, case-variant stream ids and the `occurred_on` repair. Event tables are copied, numbered in 3.x's order and swapped in, keeping the 3.x table as `<table>__es_v1`; `occurred_on` is restored to the millisecond from the event ids, which also corrects values that 3.x stored hours off when the application ran in another time zone than the server. Snapshot tables are converted in place. A failed run continues where it stopped. `migrations/4.0.sql` holds the statements for the default pool.
- `connect()` fails the bootstrap on a bad connection, and `disconnect()` can be called more than once.

**Migration**

1. Take a backup, then run the dry runs with the 4.0 package and review the reports:

   ```ts
   await MariaDBEventStore.migrate(config, { dryRun: true });
   await MariaDBSnapshotStore.migrate(config, { dryRun: true });
   ```

2. Stop every 3.x instance: the migration is offline. 3.x event appends fail afterwards (error 1136), but 3.x snapshot writes would still succeed.
3. Run `MariaDBEventStore.migrate(config)`, then `MariaDBSnapshotStore.migrate(config)`, then deploy 4.0. Plan for about 3 minutes per million events, and free space of 1.5 times the event tables in the data directory and again in `tmpdir`.
4. Drop the `<table>__es_v1` backups when you are satisfied.
5. Stream ids that differed in case only are separate streams now, and a stream with a gap in its versions conflicts on its next append; append after the conflict's `actualVersion`.
