# @ocoda/event-sourcing-mariadb

## 4.0.0-next.2

### Major Changes

- [#597](https://github.com/ocoda/event-sourcing/pull/597) [`8c98184`](https://github.com/ocoda/event-sourcing/commit/8c9818402947d165e2f9c02717e12f084270e5a0) Thanks [@drieshooghe](https://github.com/drieshooghe)! - The `mariadb` peer dependency now requires `^3.5.3` (was `^3.0.0`). Connector versions below it are affected by three advisories: the cleartext password can leak to a man-in-the-middle despite `ssl: true` (GHSA-cqhc-2h57-wpxf, high), credentials can be sent unprotected (GHSA-42r5-vhpq-m858) and `Buffer` parameters can be escaped unsafely under some multi-byte client character sets (GHSA-g5xc-5w98-jfvm). Upgrade the driver with your package manager, for example `npm install mariadb@^3.5.3`.

- [#571](https://github.com/ocoda/event-sourcing/pull/571) [`11d0fb3`](https://github.com/ocoda/event-sourcing/commit/11d0fb3e0fea554e82bda920c4f2e93e50caba46) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **MariaDB schema v2: the MariaDB stores implement the 4.0 store contract.** `MariaDBEventStore` stores global positions, metadata and headers and reads all events with `readAll`; `MariaDBSnapshotStore` keeps one latest snapshot per stream. Tables created by 3.x must be migrated once with `migrate()`. See [MariaDB](https://ocoda.github.io/event-sourcing/integrations/mariadb) and the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#mariadb-schema-v2).
  
  - **Event store.** The options form of `appendEvents` with `ExpectedVersion.Any`, `correlationId`, `causationId` and `headers`, and `readAll({ fromPosition, batch, pool })` with a `globalPosition` per pool from `1n`. Capabilities: `{ atomicAppend: true, headers: true, globalOrder: 'gap-safe' }` on InnoDB, `'best-effort'` on a Galera cluster. `getAllEnvelopes` is removed: use `readAll({ fromPosition, batch, pool })`. Appends run in `READ COMMITTED` and take their positions from a counter per pool, so the appends to one pool are serialized; use pools to scale writes. The stores' sessions run in `READ COMMITTED` (added after your `initSql`), and `readAll` must read from the server the appends run on, not from a replica behind a read/write-splitting proxy.
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
  4. Drop the `<table>__es_v1` backups when you are satisfied: run `MariaDBEventStore.migrate(config, { keepBackup: false })` once more.
  5. A 3.x stream whose rows have ids that differ in case only is one stream under the id of its lowest version, which the dry run lists (`canonicalizedStreams`): use those ids from now on. A stream with a gap in its versions conflicts on its next append; append after the conflict's `actualVersion`.

### Minor Changes

- [#596](https://github.com/ocoda/event-sourcing/pull/596) [`f124698`](https://github.com/ocoda/event-sourcing/commit/f1246981d8e46ec56157e7e15e36a1f63538fac2) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **The MariaDB migration keeps 3.x streams whose ids differ in case only as one stream, and needs less work by hand.** The 3.x tables compared stream ids case-insensitively, so one 3.x stream could hold `account-Acc-1` version 1 and `account-acc-1` version 2. Schema v2 compares stream ids in binary, and the migration used to split such a stream into two, one of them starting at version 2.
  
  - **One stream id per 3.x stream.** `MariaDBEventStore.migrate()` gives every row of such a stream the stream id of its lowest version (`account-Acc-1`), and a renamed row the aggregate id of that version when the two differ in case only. `MariaDBSnapshotStore.migrate()` gives every snapshot stream the stream id of its events, from the pool's 3.x event table or its `__es_v1` backup, or else the id of its lowest snapshot. It is deterministic, and a rerun after a crash ends in the same state. **After the migration, use those stream ids**: 4.0 reads `account-acc-1` as another, empty stream. Keep the events' backups (the default) until the snapshots are migrated.
  - **The report lists them.** A new `canonicalizedStreams: { total, rows, sample }` on `MigrationCollectionReport` gives, per stream, the id it takes, the ids it replaces and the rows that change (a sample of up to 1,000 streams), in the dry run and in the migration's report, with a warning that shows a few. `caseVariantStreams` now also counts snapshot streams. `gappedStreams` and `snapshotFlags` count a 3.x stream once, so a case-variant stream no longer shows up as gapped.
  - **A missing privilege fails before the copy.** The event migration renames the empty copy and back (`probe-swap`), which needs the swap's privileges, so a user without `ALTER` fails there instead of at the swap after the whole copy. The dry run still can't check privileges.
  - **Lock waits name the sessions.** With the `PROCESS` privilege, a step that times out on a lock lists the sessions with an open transaction (`KILL <id>` ends one).
  - **Galera.** The migration replicates in fragments of 64 MiB, or of half the node's `wsrep_max_ws_size` when that is smaller, so it no longer fails on a smaller `wsrep_max_ws_size`.
  - **Dropping the backups** needs no SQL: run `MariaDBEventStore.migrate(config, { keepBackup: false })` again, after the snapshots are migrated. When `keepBackup: false` would drop the backup of a pool whose snapshot table isn't migrated yet, the dry run and the report warn about it.
  - `migrations/4.0.sql` has the new statements, and suggests dropping the events' backup only after the snapshots.

### Patch Changes

- Updated dependencies [[`c62d7ce`](https://github.com/ocoda/event-sourcing/commit/c62d7ce1f93007b73437888c42c32d5b1a6547e3), [`f124698`](https://github.com/ocoda/event-sourcing/commit/f1246981d8e46ec56157e7e15e36a1f63538fac2), [`6443fae`](https://github.com/ocoda/event-sourcing/commit/6443fae132e584776fa75cda6e9d3a8798647da8), [`7f1e82c`](https://github.com/ocoda/event-sourcing/commit/7f1e82cb91dff9eb458cfcca8600889e865ba52d), [`117cb88`](https://github.com/ocoda/event-sourcing/commit/117cb88f62796521fc28e8bb9f962a674d12139b), [`37c679c`](https://github.com/ocoda/event-sourcing/commit/37c679ca62393c8c3cc6208a995eadc2f83fd5f8), [`65303fc`](https://github.com/ocoda/event-sourcing/commit/65303fc99a48f65ec2b3f8c104f4f9b3b6d1644e), [`433e151`](https://github.com/ocoda/event-sourcing/commit/433e1516810e0e654deda995fcd366755a3a288d), [`c63ab9b`](https://github.com/ocoda/event-sourcing/commit/c63ab9bda8224fd8ba1d682525e92c8c588cad23), [`29aa8fe`](https://github.com/ocoda/event-sourcing/commit/29aa8fee3d881524e37095a281c592b0b1f1464b), [`11dacb2`](https://github.com/ocoda/event-sourcing/commit/11dacb2f7a146245c19a3efd76e254b09fb4294e), [`57b20c5`](https://github.com/ocoda/event-sourcing/commit/57b20c55a6dbed7632e0e0511f0cfba3efb5a519), [`ee00755`](https://github.com/ocoda/event-sourcing/commit/ee007553983d7cdebba6bdf23bf557a83eebe834)]:
  - @ocoda/event-sourcing@4.0.0-next.2

## 4.0.0-next.1

### Patch Changes

- [#556](https://github.com/ocoda/event-sourcing/pull/556) [`c82f392`](https://github.com/ocoda/event-sourcing/commit/c82f3923123f5b02def706f10984cd8a69c61c4a) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **The stores report their failures with the new error fields of `@ocoda/event-sourcing` 4.0.**
  
  - A version conflict carries the stream, the pool, the expected version and the version the stream was at. When the append lost a race on the unique (stream, version) key and the store can't read the current version, `actualVersion` is left out instead of reporting a guess.
  - An `EventStorePersistenceException` says whether the events may have been stored. PostgreSQL reports `'unknown'` once it issued the insert (a failure to get a pooled connection for it included), unless the server rejected the statement (an error of severity `ERROR`, which rolls the insert back); MariaDB only when the commit failed; and MongoDB whenever the insert failed, because its multi-document insert isn't atomic. Every earlier failure, such as the version check, is `'not-persisted'`.
  - MongoDB: when an append loses a race on the unique key after storing some of its events and those can't be removed again, the store now throws an `EventStorePersistenceException` with `outcome: 'unknown'` (the `cause` is an `AggregateError` with both errors) instead of a version conflict, which promises that nothing was stored.
  - The driver error is the `cause` of the exception, and not-found exceptions name the pool they searched.
- Updated dependencies [[`c82f392`](https://github.com/ocoda/event-sourcing/commit/c82f3923123f5b02def706f10984cd8a69c61c4a)]:
  - @ocoda/event-sourcing@4.0.0-next.1

## 4.0.0-next.0

### Major Changes

- [#543](https://github.com/ocoda/event-sourcing/pull/543) [`95b19f2`](https://github.com/ocoda/event-sourcing/commit/95b19f2a6e3681f4968795f2c83749c6e88f83e5) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Move to NestJS 12 and publish the packages as ES modules only.
  
  **Breaking changes**
  
  - **NestJS 12 only.** The core peers on `@nestjs/common` and `@nestjs/core` `^12.0.0` and on `rxjs` `^7.8.0`. NestJS 11 applications stay on 3.x, which keeps receiving fixes.
  - **ESM-only.** Every package ships one ES module build (`"type": "module"`), and its `exports` map points `import`, `require` and `default` at the same file. ESM applications import the packages as before. CommonJS applications, including TypeScript compiled to CommonJS, keep using `require()`: Node.js 22.12 and later load ES modules through `require()` natively. Because there is no second CommonJS build, Nest never sees two copies of a class such as `EventStore`.
  - **Node.js 22.12 or later** is required (`engines.node` is `>=22.12`).
  - **The database drivers are peer dependencies.** The integrations no longer install their driver, so install it next to the integration, in the version you choose:
    - `@ocoda/event-sourcing-postgres`: `pg` (`^8.15.0`, the first release with an ES module entry) and `pg-cursor` (`^2.14.0`). TypeScript projects also need `@types/pg` and `@types/pg-cursor`.
    - `@ocoda/event-sourcing-mongodb`: `mongodb` (`^6.10.0 || ^7.0.0`).
    - `@ocoda/event-sourcing-mariadb`: `mariadb` (`^3.0.0`).
  - The integrations now peer on `@nestjs/common` `^12.0.0` and on `@ocoda/event-sourcing` with a caret range (`^4.0.0`) instead of an exact version. They no longer list `@nestjs/core`, `rxjs` or `reflect-metadata`, which they do not import.
  - **The root entry shims are gone.** The `index.js`, `index.d.ts` and `index.ts` files next to each `package.json` were removed, and `exports` exposes only the package root and `package.json`. Import from the package name (`@ocoda/event-sourcing`, `@ocoda/event-sourcing-postgres`, ...); paths into the package, such as `@ocoda/event-sourcing/dist/...`, no longer resolve.
  
  The stored event and snapshot formats are unchanged, so no data migration is needed.
  
  **Migrating from 3.x**
  
  1. Upgrade the application to NestJS 12 and Node.js 22.12 or later.
  2. Install the driver of every integration you use, for example `npm install pg pg-cursor` for PostgreSQL or `npm install mongodb` for MongoDB.
  3. Replace any import of a path inside the packages with an import from the package name.
  4. CommonJS applications need no code changes. A test runner with its own module loader, such as Jest, loads these packages with the same setup it needs for NestJS 12, which is ESM-only as well.
  
  The DynamoDB store (`@ocoda/event-sourcing-dynamodb`) is not released for 4.0, because DynamoDB can't give the events the gap-free global order that the 4.0 read side relies on. To keep using DynamoDB, stay on 3.x, which keeps receiving fixes, or move to the PostgreSQL, MariaDB or MongoDB store.

- [#548](https://github.com/ocoda/event-sourcing/pull/548) [`c87efea`](https://github.com/ocoda/event-sourcing/commit/c87efea2581cf403012672d2dd4e02688541e5a0) Thanks [@drieshooghe](https://github.com/drieshooghe)! - 4.0 is the next major release: NestJS 12, ESM-only packages, Node.js 22.12 or later, and more. Every breaking change has its own entry in this changelog, with the steps to migrate from 3.x.

### Patch Changes

- [#540](https://github.com/ocoda/event-sourcing/pull/540) [`c9b66f7`](https://github.com/ocoda/event-sourcing/commit/c9b66f702081e5fa0a39f0d7f714a4ba87b184ef) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Fix two reads of the MariaDB snapshot store.
  
  - `getLastSnapshots([])` and `getManyLastSnapshotEnvelopes([])`, and so `SnapshotRepository.loadMany([])`, return an empty map instead of failing with an SQL syntax error.
  - `getLastEnvelopesForAggregate`, and so `SnapshotRepository.loadAll`, returns the streams in descending order of their stream id, like the other stores. The query had no `ORDER BY`, so MariaDB returned them in index order, which in practice was ascending.
    **Behaviour change:** on MariaDB, the order of `loadAll` is reversed, and a `limit` now returns the streams with the highest stream ids instead of the lowest. If you relied on the old order, sort the results yourself.
- Updated dependencies [[`c9b66f7`](https://github.com/ocoda/event-sourcing/commit/c9b66f702081e5fa0a39f0d7f714a4ba87b184ef), [`95b19f2`](https://github.com/ocoda/event-sourcing/commit/95b19f2a6e3681f4968795f2c83749c6e88f83e5), [`c87efea`](https://github.com/ocoda/event-sourcing/commit/c87efea2581cf403012672d2dd4e02688541e5a0)]:
  - @ocoda/event-sourcing@4.0.0-next.0

## 3.0.1

### Patch Changes

- [#526](https://github.com/ocoda/event-sourcing/pull/526) [`b93acfa`](https://github.com/ocoda/event-sourcing/commit/b93acfaea457a6ee1e7cb2b345bd9f5ca8cb695d) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Harden the MariaDB and MongoDB event and snapshot stores.

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

- Updated dependencies [[`c2f0b47`](https://github.com/ocoda/event-sourcing/commit/c2f0b479ad295d0c92b1cf3c522bac23424c8c81)]:
  - @ocoda/event-sourcing@3.0.1

## 3.0.0

### Patch Changes

- [#474](https://github.com/ocoda/event-sourcing/pull/474) [`7a14fea`](https://github.com/ocoda/event-sourcing/commit/7a14feab663e0d0f323b017127e2771aae6b9183) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Expand shared E2E coverage, align integration test structure, and add core bus edge-case tests.

- Updated dependencies [[`6290979`](https://github.com/ocoda/event-sourcing/commit/6290979d9727a1edbede492c19a330ddef5ba736), [`7a14fea`](https://github.com/ocoda/event-sourcing/commit/7a14feab663e0d0f323b017127e2771aae6b9183)]:
  - @ocoda/event-sourcing@3.0.0

## 2.1.4

### Patch Changes

- [#445](https://github.com/ocoda/event-sourcing/pull/445) [`44b1c31`](https://github.com/ocoda/event-sourcing/commit/44b1c311f06bbc800997934d0c18401f4b214895) Thanks [@renovate](https://github.com/apps/renovate)! - Update all non-major dependencies

- [#450](https://github.com/ocoda/event-sourcing/pull/450) [`0ca4ef4`](https://github.com/ocoda/event-sourcing/commit/0ca4ef4cd413f0196f09917d6037b76604fc00f1) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Fix serializing event payloads to save to Postgres

- Updated dependencies [[`44b1c31`](https://github.com/ocoda/event-sourcing/commit/44b1c311f06bbc800997934d0c18401f4b214895), [`0ca4ef4`](https://github.com/ocoda/event-sourcing/commit/0ca4ef4cd413f0196f09917d6037b76604fc00f1)]:
  - @ocoda/event-sourcing@2.1.4

## 2.1.3

### Patch Changes

- [#442](https://github.com/ocoda/event-sourcing/pull/442) [`c8762dc`](https://github.com/ocoda/event-sourcing/commit/c8762dcb54b2be608b85d4dfb80b7f0880ee828d) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Bump dependencies

- Updated dependencies [[`c8762dc`](https://github.com/ocoda/event-sourcing/commit/c8762dcb54b2be608b85d4dfb80b7f0880ee828d)]:
  - @ocoda/event-sourcing@2.1.3

## 2.1.2

### Patch Changes

- [#433](https://github.com/ocoda/event-sourcing/pull/433) [`d645eaa`](https://github.com/ocoda/event-sourcing/commit/d645eaac2b7aca74303eb2908c6af64bd3491d92) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Bump dependencies

- Updated dependencies [[`d645eaa`](https://github.com/ocoda/event-sourcing/commit/d645eaac2b7aca74303eb2908c6af64bd3491d92)]:
  - @ocoda/event-sourcing@2.1.2

## 2.1.1

### Patch Changes

- [#422](https://github.com/ocoda/event-sourcing/pull/422) [`2711e2e`](https://github.com/ocoda/event-sourcing/commit/2711e2e3d26b1ee5ea76e6c0922e92f86ef74a4b) Thanks [@MartinLG-LaFourche](https://github.com/MartinLG-LaFourche)! - # Enhancements
  Enforces the linter to check for strictNullChecks.

  # Dependencies

  Updated various dependencies to their latest versions.

- Updated dependencies [[`2711e2e`](https://github.com/ocoda/event-sourcing/commit/2711e2e3d26b1ee5ea76e6c0922e92f86ef74a4b)]:
  - @ocoda/event-sourcing@2.1.1

## 2.1.0

### Minor Changes

- [#419](https://github.com/ocoda/event-sourcing/pull/419) [`cbc7b08`](https://github.com/ocoda/event-sourcing/commit/cbc7b082555cb0855cd26965020b152c679e6e47) Thanks [@drieshooghe](https://github.com/drieshooghe)! - # Fixes
  Fixes an issue where the metadata from custom event-serializers wasn't returned as an object, resulting in them not being registered by the handlers loader.

  # Deprecates

  Removes the `disableDefaultSerializer` option from the module, but falls back to the default serializer for each event that doesn't have a custom event-serializer registered. Refactored because the previous behavior left the event-serializer for an event empty, which doesn't make sense.

  # Dependencies

  Updated various dependencies to their latest versions, including:

  - `@aws-sdk/client-dynamodb` & `@aws-sdk/util-dynamodb` to `3.758.0`
  - `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, and `@nestjs/testing` to `11.0.11`
  - `@changesets/changelog-github` & `@changesets/cli` to their latest versions
  - `@faker-js/faker` to `9.5.1`
  - `@swc/core` to `1.11.5`
  - `mongodb` to `6.14.0`
  - `next` to `15.2.0`
  - `pg` to `8.13.3` and `pg-cursor` to `2.12.3`
  - `rxjs` to `7.8.2`
  - `tsup` to `8.4.0`
  - `turbo` to `2.4.4`
  - `typescript` to `5.8.2`

  These updates include minor fixes, performance improvements, and compatibility enhancements.

### Patch Changes

- Updated dependencies [[`cbc7b08`](https://github.com/ocoda/event-sourcing/commit/cbc7b082555cb0855cd26965020b152c679e6e47)]:
  - @ocoda/event-sourcing@2.1.0

## 2.0.0

### Major Changes

- [#406](https://github.com/ocoda/event-sourcing/pull/406) [`d22f846`](https://github.com/ocoda/event-sourcing/commit/d22f8463febe06e43282a10c6fcafdd43a9877e7) Thanks [@renovate](https://github.com/apps/renovate)! - Major bump NestJS dependencies

  - Drops support for NodeJS 18 as it is no longer supported by NestJS v11
  - Bumps dev dependencies

### Patch Changes

- Updated dependencies [[`d22f846`](https://github.com/ocoda/event-sourcing/commit/d22f8463febe06e43282a10c6fcafdd43a9877e7)]:
  - @ocoda/event-sourcing@2.0.0

## 1.1.6

### Patch Changes

- [#407](https://github.com/ocoda/event-sourcing/pull/407) [`475513a`](https://github.com/ocoda/event-sourcing/commit/475513a6eaa92d3e8e8b2383f539a7518264fd5b) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

- Updated dependencies [[`475513a`](https://github.com/ocoda/event-sourcing/commit/475513a6eaa92d3e8e8b2383f539a7518264fd5b)]:
  - @ocoda/event-sourcing@1.1.6

## 1.1.5

### Patch Changes

- [#402](https://github.com/ocoda/event-sourcing/pull/402) [`2ea7e18`](https://github.com/ocoda/event-sourcing/commit/2ea7e1849fe3ac4b623246b7662f0e6480be4594) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

- Updated dependencies [[`2ea7e18`](https://github.com/ocoda/event-sourcing/commit/2ea7e1849fe3ac4b623246b7662f0e6480be4594)]:
  - @ocoda/event-sourcing@1.1.5

## 1.1.4

### Patch Changes

- [#400](https://github.com/ocoda/event-sourcing/pull/400) [`f83eb04`](https://github.com/ocoda/event-sourcing/commit/f83eb045648f107282761f807d870f8844df2bd9) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

- Updated dependencies [[`f83eb04`](https://github.com/ocoda/event-sourcing/commit/f83eb045648f107282761f807d870f8844df2bd9)]:
  - @ocoda/event-sourcing@1.1.4

## 1.1.3

### Patch Changes

- [#393](https://github.com/ocoda/event-sourcing/pull/393) [`4375b25`](https://github.com/ocoda/event-sourcing/commit/4375b25ea95ec6dd954ae6f34d8e3797ebbefb36) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

- Updated dependencies [[`4375b25`](https://github.com/ocoda/event-sourcing/commit/4375b25ea95ec6dd954ae6f34d8e3797ebbefb36)]:
  - @ocoda/event-sourcing@1.1.3

## 1.1.2

### Patch Changes

- [#388](https://github.com/ocoda/event-sourcing/pull/388) [`154d20a`](https://github.com/ocoda/event-sourcing/commit/154d20ae3a4845e273c47d970c1b2f3f25daf1f0) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

- Updated dependencies [[`154d20a`](https://github.com/ocoda/event-sourcing/commit/154d20ae3a4845e273c47d970c1b2f3f25daf1f0)]:
  - @ocoda/event-sourcing@1.1.2

## 1.1.1

### Patch Changes

- [#384](https://github.com/ocoda/event-sourcing/pull/384) [`9f9af0e`](https://github.com/ocoda/event-sourcing/commit/9f9af0e3bfa36239121886635013ca515f38b09f) Thanks [@renovate](https://github.com/apps/renovate)! - Update dependencies

- Updated dependencies [[`9f9af0e`](https://github.com/ocoda/event-sourcing/commit/9f9af0e3bfa36239121886635013ca515f38b09f)]:
  - @ocoda/event-sourcing@1.1.1

## 1.1.0

### Minor Changes

- [#371](https://github.com/ocoda/event-sourcing/pull/371) [`eff4abd`](https://github.com/ocoda/event-sourcing/commit/eff4abda2b44a7fbcb1be7bccde7fc9267e7fded) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Support for a getAllEnvelopes method on the EventStore

### Patch Changes

- Updated dependencies [[`eff4abd`](https://github.com/ocoda/event-sourcing/commit/eff4abda2b44a7fbcb1be7bccde7fc9267e7fded)]:
  - @ocoda/event-sourcing@1.1.0

## 1.0.2

### Patch Changes

- [#361](https://github.com/ocoda/event-sourcing/pull/361) [`5be1d42`](https://github.com/ocoda/event-sourcing/commit/5be1d42d1eb0a19a252d2127b72a756b3cd701f6) Thanks [@renovate](https://github.com/apps/renovate)! - Dependency updates

- Updated dependencies [[`5be1d42`](https://github.com/ocoda/event-sourcing/commit/5be1d42d1eb0a19a252d2127b72a756b3cd701f6)]:
  - @ocoda/event-sourcing@1.0.2

## 1.0.1

### Patch Changes

- [#362](https://github.com/ocoda/event-sourcing/pull/362) [`8081e16`](https://github.com/ocoda/event-sourcing/commit/8081e16d3edcab21efa301a7e1261cfd062ab4e7) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Introduce ULID based event-ids and make sure these are persisted/retrieved correctly within the integrations

- [#362](https://github.com/ocoda/event-sourcing/pull/362) [`94e41eb`](https://github.com/ocoda/event-sourcing/commit/94e41ebea9a5d3762d39db0a3afb664bc0d78010) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Adds a `listCollections` method to all integrations

- Updated dependencies [[`8081e16`](https://github.com/ocoda/event-sourcing/commit/8081e16d3edcab21efa301a7e1261cfd062ab4e7), [`94e41eb`](https://github.com/ocoda/event-sourcing/commit/94e41ebea9a5d3762d39db0a3afb664bc0d78010)]:
  - @ocoda/event-sourcing@1.0.1

## 1.0.0

### Major Changes

- This marks the first stable release of the library, which consists of the following changes:

  - all database-specific libraries have been migrated to their own libraries to reduce the bundle size
  - the `SnapshotHandler` was renamed to `SnapshotRepository`
  - the `SnapshotRepository` was provided with additional methods for retrieving snapshots in bulk
  - the database drivers were optimized (e.g. by only fetching the needed fields)
  - the DynamoDB snapshot-store serialization was fixed

### Patch Changes

- Updated dependencies
  - @ocoda/event-sourcing@1.0.0
