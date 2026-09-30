# @ocoda/event-sourcing-mongodb

## 4.0.0

### Major Changes

- [#572](https://github.com/ocoda/event-sourcing/pull/572) [`8f4e729`](https://github.com/ocoda/event-sourcing/commit/8f4e7298e725ad020a0b84f503796e21d2d16702) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **MongoDB schema v2: the MongoDB stores implement the 4.0 store contract.** Collections that 3.x created must be migrated once, offline, with `MongoDBEventStore.migrate()` and `MongoDBSnapshotStore.migrate()`. See [MongoDB](https://ocoda.github.io/event-sourcing/integrations/mongodb) and the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#mongodb-schema-v2).
  
  - **The event store goes native.** It implements `getStreamVersion`, `getEnvelope(s)`, `readAll` and `persistEvents`; the base class does the appends. `appendEvents` takes the options form with `ExpectedVersion.Any`, a correlation id, a causation id and headers, and returns envelopes with their `globalPosition`. `getAllEnvelopes` is gone from this store: use `readAll({ fromPosition, batch, pool })`. Every read of a pool that was never ensured throws an `EventCollectionNotFoundException`.
  - **Schema v2.** Event documents gain a 64-bit `globalPosition`, `headers` and `eventVersion`, and lose `eventDate`; absent metadata is left out instead of stored as `null`. Each event collection has unique `{ streamId, version }` and `{ globalPosition }` indexes and a validator that requires the position, which also fences 3.x writers off a migrated collection. A catalog collection, `event_sourcing_collections`, holds each pool's position counter and each collection's schema version, and `listCollections()` reads it.
  - **Capabilities depend on the topology**, detected with `hello` in `connect()`: a replica set is `{ atomicAppend: true, headers: true, globalOrder: 'gap-safe' }` (an append is one transaction that takes its positions first and whose commit waits for the majority at most until the append's 30-second budget ends; `readAll` reads with majority read concern); a sharded cluster is atomic but `'best-effort'`; a standalone server is `{ atomicAppend: false, globalOrder: 'best-effort' }`, where a failed append leaves holes in the positions, and the store warns once. Run MongoDB as a replica set; a single-node one is enough.
  - **Bootstrap refuses 3.x event collections.** `ensureCollection` never migrates: a 3.x event collection throws an `EventStoreSchemaException` (`found: 'v1'`, or `'v1-partial'` for an interrupted migration) whose remedy names `migrate()`. A 3.x snapshot collection keeps working, with a warning, until it is migrated. A registered collection that lost its validator or unique indexes (dropped while a store ran, then created again by an insert) gets them back from `ensureCollection`.
  - **`migrate(options)`** (static, without a Nest application, and on a connected store): a dry run reports every collection with its state, gapped streams, non-canonical event ids, damaged snapshot flags, the indexes it drops, what blocks it (a sharded collection, a server before 5.0, non-string ids, a validator of its own, the privileges its remaining steps need, another run's lease, an exclusive lock that isn't free within `lockTimeoutMs`) and the exact mongosh statements; the migration fences, numbers the events 1…N in 3.x's order on the server with every stream in version order, indexes and registers them, then removes `eventDate` (deferrable with `unsetEventDate: false`). It resumes an interrupted run, a run whose lease another run took over stops, and a second run skips. The static form leaves the client's `socketTimeoutMS` and `timeoutMS` out, since the numbering is one long operation. Snapshots get exactly one latest flag per stream, on the highest version. The package ships the same migration for the default pools as `migrations/4.0.mongosh.js`, which checks what would block it before it writes.
  - **`ddl: 'auto' | 'none'`**, a new option of both stores: with `'none'`, `ensureCollection` only checks and registers collections and names the statements that create a missing one.
  - **Snapshots.** A unique partial index keeps a single latest snapshot per stream, also when appends race (on a replica set the unflagging and the insert are one transaction; on a standalone server a failed insert flags the previous snapshot again). `getLastSnapshot` and `getLastEnvelope` read the highest version; `getLastEnvelopesForAggregate` pages in descending binary order of the aggregate ids with an exclusive `aggregateId` cursor. An unflagged snapshot has no `latest` field.
  - **`disconnect()`** can be called more than once, and before `connect()`.

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

- [#556](https://github.com/ocoda/event-sourcing/pull/556) [`c82f392`](https://github.com/ocoda/event-sourcing/commit/c82f3923123f5b02def706f10984cd8a69c61c4a) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **The stores report their failures with the new error fields of `@ocoda/event-sourcing` 4.0.**
  
  - A version conflict carries the stream, the pool, the expected version and the version the stream was at. When the append lost a race on the unique (stream, version) key and the store can't read the current version, `actualVersion` is left out instead of reporting a guess.
  - An `EventStorePersistenceException` says whether the events may have been stored. PostgreSQL reports `'unknown'` once it issued the insert (a failure to get a pooled connection for it included), unless the server rejected the statement (an error of severity `ERROR`, which rolls the insert back); MariaDB only when the commit failed; and MongoDB whenever the insert failed, because its multi-document insert isn't atomic. Every earlier failure, such as the version check, is `'not-persisted'`.
  - MongoDB: when an append loses a race on the unique key after storing some of its events and those can't be removed again, the store now throws an `EventStorePersistenceException` with `outcome: 'unknown'` (the `cause` is an `AggregateError` with both errors) instead of a version conflict, which promises that nothing was stored.
  - The driver error is the `cause` of the exception, and not-found exceptions name the pool they searched.
- Updated dependencies [[`c62d7ce`](https://github.com/ocoda/event-sourcing/commit/c62d7ce1f93007b73437888c42c32d5b1a6547e3), [`c9b66f7`](https://github.com/ocoda/event-sourcing/commit/c9b66f702081e5fa0a39f0d7f714a4ba87b184ef), [`f124698`](https://github.com/ocoda/event-sourcing/commit/f1246981d8e46ec56157e7e15e36a1f63538fac2), [`6443fae`](https://github.com/ocoda/event-sourcing/commit/6443fae132e584776fa75cda6e9d3a8798647da8), [`7f1e82c`](https://github.com/ocoda/event-sourcing/commit/7f1e82cb91dff9eb458cfcca8600889e865ba52d), [`c82f392`](https://github.com/ocoda/event-sourcing/commit/c82f3923123f5b02def706f10984cd8a69c61c4a), [`117cb88`](https://github.com/ocoda/event-sourcing/commit/117cb88f62796521fc28e8bb9f962a674d12139b), [`37c679c`](https://github.com/ocoda/event-sourcing/commit/37c679ca62393c8c3cc6208a995eadc2f83fd5f8), [`95b19f2`](https://github.com/ocoda/event-sourcing/commit/95b19f2a6e3681f4968795f2c83749c6e88f83e5), [`65303fc`](https://github.com/ocoda/event-sourcing/commit/65303fc99a48f65ec2b3f8c104f4f9b3b6d1644e), [`c87efea`](https://github.com/ocoda/event-sourcing/commit/c87efea2581cf403012672d2dd4e02688541e5a0), [`433e151`](https://github.com/ocoda/event-sourcing/commit/433e1516810e0e654deda995fcd366755a3a288d), [`c63ab9b`](https://github.com/ocoda/event-sourcing/commit/c63ab9bda8224fd8ba1d682525e92c8c588cad23), [`29aa8fe`](https://github.com/ocoda/event-sourcing/commit/29aa8fee3d881524e37095a281c592b0b1f1464b), [`11dacb2`](https://github.com/ocoda/event-sourcing/commit/11dacb2f7a146245c19a3efd76e254b09fb4294e), [`57b20c5`](https://github.com/ocoda/event-sourcing/commit/57b20c55a6dbed7632e0e0511f0cfba3efb5a519), [`ee00755`](https://github.com/ocoda/event-sourcing/commit/ee007553983d7cdebba6bdf23bf557a83eebe834)]:
  - @ocoda/event-sourcing@4.0.0

## 4.0.0-next.2

### Major Changes

- [#572](https://github.com/ocoda/event-sourcing/pull/572) [`8f4e729`](https://github.com/ocoda/event-sourcing/commit/8f4e7298e725ad020a0b84f503796e21d2d16702) Thanks [@drieshooghe](https://github.com/drieshooghe)! - **MongoDB schema v2: the MongoDB stores implement the 4.0 store contract.** Collections that 3.x created must be migrated once, offline, with `MongoDBEventStore.migrate()` and `MongoDBSnapshotStore.migrate()`. See [MongoDB](https://ocoda.github.io/event-sourcing/integrations/mongodb) and the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#mongodb-schema-v2).
  
  - **The event store goes native.** It implements `getStreamVersion`, `getEnvelope(s)`, `readAll` and `persistEvents`; the base class does the appends. `appendEvents` takes the options form with `ExpectedVersion.Any`, a correlation id, a causation id and headers, and returns envelopes with their `globalPosition`. `getAllEnvelopes` is gone from this store: use `readAll({ fromPosition, batch, pool })`. Every read of a pool that was never ensured throws an `EventCollectionNotFoundException`.
  - **Schema v2.** Event documents gain a 64-bit `globalPosition`, `headers` and `eventVersion`, and lose `eventDate`; absent metadata is left out instead of stored as `null`. Each event collection has unique `{ streamId, version }` and `{ globalPosition }` indexes and a validator that requires the position, which also fences 3.x writers off a migrated collection. A catalog collection, `event_sourcing_collections`, holds each pool's position counter and each collection's schema version, and `listCollections()` reads it.
  - **Capabilities depend on the topology**, detected with `hello` in `connect()`: a replica set is `{ atomicAppend: true, headers: true, globalOrder: 'gap-safe' }` (an append is one transaction that takes its positions first and whose commit waits for the majority at most until the append's 30-second budget ends; `readAll` reads with majority read concern); a sharded cluster is atomic but `'best-effort'`; a standalone server is `{ atomicAppend: false, globalOrder: 'best-effort' }`, where a failed append leaves holes in the positions, and the store warns once. Run MongoDB as a replica set; a single-node one is enough.
  - **Bootstrap refuses 3.x event collections.** `ensureCollection` never migrates: a 3.x event collection throws an `EventStoreSchemaException` (`found: 'v1'`, or `'v1-partial'` for an interrupted migration) whose remedy names `migrate()`. A 3.x snapshot collection keeps working, with a warning, until it is migrated. A registered collection that lost its validator or unique indexes (dropped while a store ran, then created again by an insert) gets them back from `ensureCollection`.
  - **`migrate(options)`** (static, without a Nest application, and on a connected store): a dry run reports every collection with its state, gapped streams, non-canonical event ids, damaged snapshot flags, the indexes it drops, what blocks it (a sharded collection, a server before 5.0, non-string ids, a validator of its own, the privileges its remaining steps need, another run's lease, an exclusive lock that isn't free within `lockTimeoutMs`) and the exact mongosh statements; the migration fences, numbers the events 1…N in 3.x's order on the server with every stream in version order, indexes and registers them, then removes `eventDate` (deferrable with `unsetEventDate: false`). It resumes an interrupted run, a run whose lease another run took over stops, and a second run skips. The static form leaves the client's `socketTimeoutMS` and `timeoutMS` out, since the numbering is one long operation. Snapshots get exactly one latest flag per stream, on the highest version. The package ships the same migration for the default pools as `migrations/4.0.mongosh.js`, which checks what would block it before it writes.
  - **`ddl: 'auto' | 'none'`**, a new option of both stores: with `'none'`, `ensureCollection` only checks and registers collections and names the statements that create a missing one.
  - **Snapshots.** A unique partial index keeps a single latest snapshot per stream, also when appends race (on a replica set the unflagging and the insert are one transaction; on a standalone server a failed insert flags the previous snapshot again). `getLastSnapshot` and `getLastEnvelope` read the highest version; `getLastEnvelopesForAggregate` pages in descending binary order of the aggregate ids with an exclusive `aggregateId` cursor. An unflagged snapshot has no `latest` field.
  - **`disconnect()`** can be called more than once, and before `connect()`.

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
