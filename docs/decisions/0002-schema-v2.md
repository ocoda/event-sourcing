# ADR 0002: Schema v2 (global position, catalog, migration)

- **Status:** Proposed
- **Date:** 2026-09-29
- **Scope:** plan milestone M7: the 4.0 event and snapshot schemas of the PostgreSQL, MariaDB and MongoDB stores, the global position technique behind [ADR 0001](./0001-v4-core-api.md) §9, and the one-time `migrate()` from 3.x
- **Depends on:** ADR 0001 §1, §8 and §9, and its [store contract amendments](./0001-v4-core-api.md#amendments-store-contract) (D1–D35)
- **Baseline:** `origin/master` `0c345dd` (`4.0.0-next.1`); the 3.x schemas that 3.0.0 to 3.0.2 create
- **Amendments:** 2026-09-29: §1 to §4 and §6 now describe the PostgreSQL (#570), MariaDB (#571) and MongoDB (#572) drivers as merged, where they follow the Wave 0 spikes and the reviews. The PostgreSQL append is one statement, and its migration rewrites the table. MariaDB reads with a hybrid reader, appends in `READ COMMITTED`, and its dry run doesn't check privileges. MongoDB numbers on the server. Each driver's [evidence](#evidence) gives the reasons. The [owner decisions](#owner-decisions) have defaults applied. 2026-09-30: after the module PR (#579), the event store's provider ensures the default pool while Nest instantiates the providers ([ADR 0001](./0001-v4-core-api.md) D38). 2026-09-30: the [owner decisions](#owner-decisions) are decided (keep `utf8mb4_bin` and `event_sourcing_collections`; the 3.x → 4 MariaDB migration needs minimal manual operations), and the MariaDB migration gives every 3.x stream one stream id, checks the swap's privileges before the copy, names the sessions behind a lock wait, and sizes its Galera fragments ([amendment](#amendment-minimal-manual-mariadb-operations)).

## Context

ADR 0001 §9 gives every event a store-assigned `globalPosition`, and §8 adds `headers` and `eventVersion`. The 3.x tables have neither. They have a year-month `event_date` column that only `getAllEnvelopes` reads, which ADR 0001 removes. 4.0 is the only release that may change the schema, so everything the 4.x read side needs lands in one migration.

Facts about 3.x that shape the design:

- **Writers.** 3.x PostgreSQL inserts list their columns, so added nullable columns don't break a 3.x writer. 3.x MariaDB inserts are positional (`INSERT INTO t VALUES (?, …)`, 10 values), so any added column breaks one. 3.x MongoDB has no validator.
- **Listing.** 3.x lists event collections by name: PostgreSQL and MariaDB `LIKE '%events'`, MongoDB `/events/`.
- **MariaDB types.** `occurred_on` and `registered_on` are `TIMESTAMP(0)`, written by a Node.js process whose time zone may differ from the server's, and the tables use the server's default (usually case-insensitive) collation. Servers created before MariaDB 10.10 can have the legacy `ON UPDATE current_timestamp()` attribute on the first `TIMESTAMP` column.
- **PostgreSQL types.** Snapshot `registered_on` is `TIMESTAMP` without a time zone, holding the writer's wall time. Index names vary: 3.0.0 used a fixed `idx_event_date_id`, later versions derive the name with `deriveIndexName`, and users may have their own.
- **Snapshots.** Every store flags the latest snapshot of a stream (`latest = 'latest#<streamId>'`), but no unique index enforces one flag per stream. 3.x MariaDB checks the previous snapshot before its transaction starts, so 3.x data can contain streams with several flags, or with none after an interrupted write.

Verified empirically on MariaDB 10.11, PostgreSQL 14 and MongoDB 8, and re-asserted by the migration specs:

- `SET SESSION explicit_defaults_for_timestamp=OFF` reproduces the legacy `ON UPDATE current_timestamp()` DDL, and an `UPDATE` that doesn't set `occurred_on = occurred_on` then overwrites `occurred_on`.
- `LAST_INSERT_ID(expr)` in an `UPDATE` works inside a transaction.
- MariaDB `TIMESTAMP → DATETIME(3)` needs `ALGORITHM=COPY`.
- PostgreSQL `varchar → text` on primary key columns keeps the `relfilenode` (no rewrite, no index rebuild), and `DROP COLUMN event_date` drops every index on `event_date`, whatever its name.
- MongoDB `$documentNumber` needs exactly one `sortBy` key.
- A MongoDB `collMod` `$jsonSchema` validator rejects 3.x-shaped inserts.

## Decision

Below, `<t>` is a collection's table or collection name: `EventCollection.get(pool)` (`events`, or `<pool>-events`) or `SnapshotCollection.get(pool)` (`snapshots`, or `<pool>-snapshots`).

### 1. Common design

**Catalog `event_sourcing_collections`.** One per PostgreSQL schema, MariaDB database or MongoDB database, with rows `(name PK, kind 'events' | 'snapshots', schema_version, last_position BIGINT default 0)`. It is:

- the **position counter** of each pool,
- the **schema registry**, and
- the **source of `listCollections`**, so v1 tables are no longer listed.

The name neither ends in nor contains `events`, so 3.x listing code never picks it up. The name is [owner decision 2](#owner-decisions).

**Positions**

- Each pool has its own positions. The first is `1n`.
- `fromPosition` is inclusive. Omitted means from the first event, and `0n` is accepted.
- An append's positions are consecutive, in array order.
- **The counter never decreases.** Registration sets `GREATEST(last_position, MAX(global_position))`, so a dropped and recreated pool continues its counter, and `ensureCollection` heals drift.
- SQL stores and MongoDB replica sets have no holes: a rollback also reverts the counter. MongoDB standalone burns positions on conflicts and failures, leaving holes that never fill.

**Gap safety** (SQL and MongoDB replica sets). The counter update is the **first write** of the append transaction, and its row lock (MongoDB: its write-conflict window) lasts until the transaction commits or aborts. Hence:

- If T1 holds block *k*, any T2 that allocates a later block does so only after T1 has committed or aborted.
- So commit order equals position order.
- A reader whose snapshot contains position *p* contains every committed position below *p*.

Readers use **keyset batches**: `WHERE global_position >= $from ORDER BY global_position LIMIT $batch`. Each batch is its own statement or snapshot, and no cursor or connection is held across a `yield`.

A driver claims `'gap-safe'` only when the `read-all-gap-safe` conformance case passes on every CI version of its database. MariaDB additionally needs the InnoDB source citation in its [evidence](#evidence).

**Detection.** `inspectEventCollection(name)` returns `absent | v1 | v1-partial | v2`, plus `registered: boolean` (a catalog row exists). It looks at columns and fields, never at index names.

- **PostgreSQL and MariaDB:**
  - `v2`: a `NOT NULL` `global_position` column and no `event_date`, except for the MariaDB case under `v1-partial`.
  - `v1`: an `event_date` column and no `global_position`.
  - `v1-partial`: anything else. On MariaDB this includes a v2-shaped table without a catalog row whose `<t>__es_v1` backup exists: a copy-swap that stopped after the `RENAME` (§6, MariaDB events). This rule is checked before the `v2` rule, so the catch-up runs and the rows 3.x wrote during the swap aren't left behind in the backup.
- **MongoDB** (the catalog document is the commit point):
  - `v2`: a catalog document with `schemaVersion: 2`.
  - `v1`: the collection exists, with no catalog document, without the v2 validator and without a `{ globalPosition: 1 }` index.
  - `v1-partial`: the v2 validator or a `{ globalPosition: 1 }` index, without a catalog document. A validator of another shape blocks the migration.

**`ensureCollection(pool)` for events.** A new `ddl` option chooses whether the store may create schema objects.

| State | `ddl: 'auto'` (default) | `ddl: 'none'` (no CREATE, ALTER or DROP; DML allowed) |
| --- | --- | --- |
| catalog missing | create it | `EventStoreSchemaException { found: 'missing', remedy: <DDL> }` |
| `absent` | create the v2 table, indexes and validator, then register | `EventStoreSchemaException { found: 'missing', remedy: <DDL> }` |
| `v2` | register, or heal the counter (`GREATEST`) | same |
| `v2` without its position index (PostgreSQL) | create it on an empty table; otherwise log the `CREATE UNIQUE INDEX CONCURRENTLY` statement; register | log the statement, register |
| `v2`, registered, but the collection is gone or lost its validator or unique indexes (MongoDB: a dropped collection that an insert created again) | create the collection, or restore the validator and indexes (with a warning) | throw, naming the statements |
| `v2`, unregistered and empty (creation crashed; on MariaDB, no `<t>__es_v1` backup) | finish the creation, register | register |
| `v1` / `v1-partial` | `EventStoreSchemaException { found, remedy: 'run XEventStore.migrate(config, { dryRun: true }), then migrate()' }`. **Never migrates.** | same |

The event store's provider calls `ensureCollection()` for the default pool while Nest instantiates the providers (ADR 0001 D22, D38), so a v1 default pool fails bootstrap with that message. Tenant pools fail on their first `ensureCollection`.

**`ensureCollection(pool)` for snapshots**

- `absent`: create the v2 table and register it (kind `'snapshots'`).
- `v1`: `logger.warn` (once per table on PostgreSQL and MongoDB, on every call on MariaDB), register it with `schema_version 1`, and keep working. The v2 SQL lists its columns, which have the same names in v1.
- `ddl: 'none'` and `absent`: `SnapshotStoreCollectionCreationException`, with the DDL in its cause (MariaDB also logs it).

**Unknown pools** (ADR 0001 amendment D4; the same in every event store)

- An append is `not-persisted`, with `cause: EventCollectionNotFoundException`, and creates nothing.
- The reads (`getEnvelope(s)`, `getEvent(s)`, `getStreamVersion`, `readAll`) throw `EventCollectionNotFoundException`. PostgreSQL maps `42P01` and MariaDB `1146`. MongoDB checks the catalog only when a first batch is empty, with a positive in-process cache. In-memory does a `Map` lookup.
- PostgreSQL `42703` and MariaDB `1054` on a read map to `EventStoreSchemaException { found: 'v1' }`.

**bigint**

- PostgreSQL and MariaDB select positions **as text** (`global_position::text`, `CAST(global_position AS CHAR)`) and convert them with `BigInt()`. MongoDB reads raw values and converts them with the shared `toPosition()`.
- Writes pass a bigint as a decimal string (SQL) or `Long.fromBigInt` (MongoDB).
- No global type parsers are installed.
- A bigint *inside a payload* makes the SQL stores fail with `not-persisted` (documented: use strings). MongoDB stores it as an Int64 and reads it back as a number.

**Limits.** Core validates stream ids, aggregate ids, event names, correlation and causation ids at ≤ 255 characters before any I/O (D14). PostgreSQL uses `TEXT`; MariaDB uses `VARCHAR(255)` and a `VARCHAR(270)` snapshot `latest`.

**Identifiers.** PostgreSQL table names must be ≤ 63 bytes and MariaDB table names ≤ 64 characters. A longer pool name is rejected by `ensureCollection` with `EventStoreCollectionCreationException`, instead of PostgreSQL's silent truncation. Derived index, constraint and backup table names are hashed the way PostgreSQL's `deriveIndexName` already does when they don't fit.

**Column order.** v2 tables append `global_position, headers, event_version` **after** the 3.x columns, so fresh and migrated tables are identical.

### 2. PostgreSQL

**Catalog.** A global advisory lock avoids the race of two concurrent `CREATE TABLE IF NOT EXISTS` on `pg_type`.

```sql
SELECT pg_advisory_xact_lock(hashtext('ocoda:event_sourcing_collections'));
CREATE TABLE IF NOT EXISTS event_sourcing_collections (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('events', 'snapshots')),
  schema_version INTEGER NOT NULL,
  last_position BIGINT NOT NULL DEFAULT 0 CHECK (last_position >= 0)
) WITH (fillfactor = 50);   -- HOT updates of the hot counter rows
```

**Events.** Created in the existing `withTransaction`, under `pg_advisory_xact_lock(hashtext(<t>))`. The `ensureTable` index option becomes a list with `unique` and `where` support.

```sql
CREATE TABLE IF NOT EXISTS "<t>" (
  stream_id TEXT NOT NULL, version INTEGER NOT NULL, event TEXT NOT NULL, payload JSONB NOT NULL,
  event_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, occurred_on TIMESTAMPTZ NOT NULL,
  correlation_id TEXT, causation_id TEXT,
  global_position BIGINT NOT NULL, headers JSONB, event_version INTEGER,
  PRIMARY KEY (stream_id, version));                         -- default name "<t>_pkey", as in 3.x
CREATE UNIQUE INDEX IF NOT EXISTS "<deriveIndexName(t, 'global_position')>" ON "<t>" (global_position);
INSERT INTO event_sourcing_collections (name, kind, schema_version, last_position)
  VALUES ($1, 'events', 2, (SELECT COALESCE(MAX(global_position), 0) FROM "<t>"))
  ON CONFLICT (name) DO UPDATE SET kind = EXCLUDED.kind, schema_version = EXCLUDED.schema_version,
    last_position = GREATEST(event_sourcing_collections.last_position, EXCLUDED.last_position)
  WHERE event_sourcing_collections.kind <> EXCLUDED.kind OR event_sourcing_collections.schema_version <> EXCLUDED.schema_version
    OR event_sourcing_collections.last_position < EXCLUDED.last_position;   -- writes nothing when the row is up to date
```

**`persistEvents`.** It encodes first (`JSON.stringify` of each payload and headers, `toISOString()` of each `occurredOn`) **before** acquiring a client, then runs one statement on a dedicated client (*amended:* one data-modifying CTE instead of a counter `UPDATE` and an `INSERT`, as the Wave 0 spike recommended: 1,033 against 663 appends per second per pool on tmpfs, 390 against 324 on disk, see the [evidence](#postgresql)):

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;   -- explicit: under REPEATABLE READ or SERIALIZABLE the waiter gets 40001
WITH counter AS (
  UPDATE event_sourcing_collections SET last_position = last_position + $12
  WHERE name = $13 AND kind = 'events' RETURNING last_position
), inserted AS (
  INSERT INTO "<t>" (stream_id, version, event, payload, event_id, aggregate_id, occurred_on,
                     correlation_id, causation_id, global_position, headers, event_version)
  SELECT e.stream_id, e.version, e.event, e.payload, e.event_id, e.aggregate_id, e.occurred_on,
         e.correlation_id, e.causation_id, counter.last_position - $12 + e.ordinality, e.headers, e.event_version
  FROM counter, unnest($1::text[], $2::int[], $3::text[], $4::jsonb[], $5::text[], $6::text[], $7::timestamptz[],
                       $8::text[], $9::text[], $10::jsonb[], $11::int[]) WITH ORDINALITY
    AS e(stream_id, version, event, payload, event_id, aggregate_id, occurred_on, correlation_id, causation_id,
         headers, event_version, ordinality)
  RETURNING 1
)
SELECT last_position::text AS last_position, (SELECT count(*) FROM inserted)::int AS inserted FROM counter;
-- no row, or fewer rows inserted than events (the pool isn't in the catalog): ROLLBACK, not-persisted
COMMIT;
```

- The counter update is still the first write, and its row lock lasts until the transaction ends. The positions are `last - n + 1n … last`, in the order of the envelopes.
- `unnest` keeps the statement at 13 parameters, whatever the number of events, which removes the 3.x ceiling of 65,535 / 10 parameters (about 6,500 events per append).
- On a `23505`, the append first releases its client, then reads the primary key constraint names from `pg_constraint` (`contype = 'p'`, including the partitions' from `pg_partition_tree`) and caches them per table, to tell a conflict from counter drift. Classifying while it still held its client could deadlock a pool whose connections were all held by racing appends.
- A client that saw a connection-level error is destroyed, not released. A `COMMIT` that the server answered with an error is `not-persisted`; one without an answer (a lost connection, an ended session: SQLSTATE class `08`, `57P01`–`57P05`, `25P03`) is `unknown`.

**Reads**

- `getStreamVersion`: `SELECT COALESCE(MAX(version), 0) AS v FROM "<t>" WHERE stream_id = $1`.
- `getEnvelope(s)`: keep `pg-cursor` for stream reads, with the new columns.
- `readAll`: a keyset over `pool.query`: `SELECT event, payload, event_id, aggregate_id, version, occurred_on, correlation_id, causation_id, global_position::text AS global_position, headers, event_version FROM "<t>" e WHERE e.global_position >= $1 ORDER BY e.global_position LIMIT $2`. The column is qualified, because `ORDER BY global_position` alone would sort by the text column of the select list.
- `listCollections`: `SELECT name FROM event_sourcing_collections WHERE kind = 'events' AND schema_version = 2 AND name > $cursor ORDER BY name LIMIT $batch`.

**Capabilities:** `{ atomicAppend: true, headers: true, globalOrder: 'gap-safe' }`, subject to the [evidence](#evidence).

**Snapshots**

```sql
CREATE TABLE IF NOT EXISTS "<t>" (
  stream_id TEXT NOT NULL, version INTEGER NOT NULL, payload JSONB NOT NULL, snapshot_id TEXT NOT NULL,
  aggregate_id TEXT NOT NULL, registered_on TIMESTAMPTZ NOT NULL, aggregate_name TEXT NOT NULL,
  latest TEXT COLLATE "C",
  PRIMARY KEY (stream_id, version));
CREATE UNIQUE INDEX IF NOT EXISTS "<deriveIndexName(t, 'latest')>" ON "<t>" (aggregate_name, latest)
  WHERE latest IS NOT NULL;
```

- `appendSnapshot` keeps the per-stream advisory lock and the transaction, and writes `registered_on` as an ISO string. A `23505` on the primary key or the latest index is a `SnapshotStoreVersionConflictException`.
- `getLastEnvelope`: `ORDER BY version DESC LIMIT 1`.
- `getLastEnvelopesForAggregate`: `WHERE aggregate_name = $1 AND latest IS NOT NULL [AND latest < 'latest#' || $2] ORDER BY latest DESC`, where `$2` is `<streamName>-<aggregateId>`. The cursor is exclusive.

### 3. MariaDB

*Amended:* this section describes the MariaDB driver as merged (#571). Where it departs from the plan, the [evidence](#mariadb) gives the reason, under "Amendments to §3 and §6".

**Catalog**

```sql
CREATE TABLE IF NOT EXISTS event_sourcing_collections (
  name VARCHAR(64) NOT NULL PRIMARY KEY, kind ENUM('events', 'snapshots') NOT NULL,
  schema_version SMALLINT NOT NULL, last_position BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
```

With `ddl: 'auto'`, `ensureCollection` runs this statement on every call; with `ddl: 'none'`, it only checks that the catalog exists.

**Events** (the collation is [owner decision 1](#owner-decisions))

```sql
CREATE TABLE IF NOT EXISTS `<t>` (
  stream_id VARCHAR(255) NOT NULL, version INT NOT NULL, event VARCHAR(255) NOT NULL, payload JSON NOT NULL,
  event_id VARCHAR(40) NOT NULL, aggregate_id VARCHAR(255) NOT NULL, occurred_on DATETIME(3) NOT NULL,
  correlation_id VARCHAR(255) NULL, causation_id VARCHAR(255) NULL,
  global_position BIGINT NOT NULL, headers JSON NULL, event_version INT NULL,
  PRIMARY KEY (stream_id, version), UNIQUE KEY ux_global_position (global_position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
-- registration by ensureCollection (amended): the highest position first, without locks, then the upsert
SELECT CAST(COALESCE(MAX(global_position), 0) AS CHAR) AS last FROM `<t>`;
INSERT INTO event_sourcing_collections (name, kind, schema_version, last_position) VALUES (?, 'events', 2, ?)
  ON DUPLICATE KEY UPDATE schema_version = 2, last_position = GREATEST(last_position, VALUES(last_position));
```

- The `INSERT … SELECT COALESCE(MAX(global_position), 0) FROM <t> … ON DUPLICATE KEY UPDATE` form of the plan locks the table's last row and deadlocked with concurrent appends, so `ensureCollection` reads the maximum first. A position committed in between is already counted, and the counter never decreases. The `ddl: 'none'` remedy and the migration keep the `INSERT … SELECT` form.
- Both stores create their pools with the user's `initSql` followed by `SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED`, so a server or `initSql` default of `READ UNCOMMITTED` can't let `readAll` hand out an append that then rolls back.

**Dates.** `DATETIME(3)` holds UTC wall time, independent of the connector's `timezone` and the session's `time_zone`:

- Write `d.toISOString().slice(0, 23).replace('T', ' ')`.
- Read `CAST(occurred_on AS CHAR)` and parse it with `new Date(s.replace(' ', 'T') + 'Z')`.

**`persistEvents`.** It encodes first (`JSON.stringify` of each payload and headers, the `DATETIME(3)` text of each `occurredOn`) **before** `getConnection()`; a value that JSON can't hold is `not-persisted`. Then, on a dedicated connection:

```sql
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;   -- amended: innodb_snapshot_isolation fails REPEATABLE READ with 1020
START TRANSACTION;                                -- these first three statements are pipelined
UPDATE event_sourcing_collections SET last_position = LAST_INSERT_ID(last_position + ?) WHERE name = ? AND kind = 'events';
-- affectedRows 0 (the pool isn't in the catalog): ROLLBACK, not-persisted (cause EventCollectionNotFoundException)
-- last = insertId as a bigint, or SELECT CAST(LAST_INSERT_ID() AS CHAR) when the connector returns an unsafe number
INSERT INTO `<t>` (stream_id, version, event, payload, event_id, aggregate_id, occurred_on,
                   correlation_id, causation_id, global_position, headers, event_version) VALUES (?, …), …;
COMMIT;
```

- The version pre-check stays outside the transaction, in the template.
- The counter update is the first write, and its row lock lasts until the transaction ends. The positions are `last - n + 1n … last`, in the order of the envelopes.
- `innodb_snapshot_isolation=ON` (the default from 11.6.2) fails a `REPEATABLE READ` transaction with `1020` once a row it read has changed, hence the explicit `READ COMMITTED`. An InnoDB `UPDATE` is a locking read of the latest committed row either way.
- A failure before the `COMMIT` issues an explicit `ROLLBACK` (a `1205` lock wait timeout doesn't roll back, `innodb_rollback_on_timeout` is off), then:
  - `1062` names its key at the end of the message, which is parsed with `/for key '(?:[^']*\.)?([^.']+)'$/`, because the duplicate value isn't escaped and a stream id can contain `for key '…'`. `PRIMARY` is a conflict (without an `actualVersion`); another key, such as `ux_global_position`, is counter drift: logged, then `not-persisted`.
  - `1146` is `not-persisted` with an `EventCollectionNotFoundException` as its cause, and everything else (`1020` included) is `not-persisted`.
- A `1213` deadlock in answer to the `COMMIT`, on a connection that is still usable, is how Galera reports a failed certification; the transaction was rolled back, so it is `not-persisted`. Any other failure of the `COMMIT` is `unknown`.
- A connection that the connector marked `fatal`, or whose `ROLLBACK` failed, is destroyed, not released.

**Reads**

- `getStreamVersion`: `SELECT COALESCE(MAX(version), 0) AS version FROM <t> WHERE stream_id = ?`.
- `getEnvelope(s)`: stream reads with `queryStream` on a dedicated connection, which is released when the consumer stops early.
- `readAll` (*amended:* the hybrid reader, because a plain keyset is not gap-safe on MariaDB; see the [evidence](#mariadb)). Each batch is one autocommit statement: `SELECT <columns>, CAST(global_position AS CHAR) AS global_position … FROM <t> e WHERE e.global_position >= ? ORDER BY e.global_position LIMIT ?`. The column is qualified, because the unqualified name in `ORDER BY` would be the text alias.
  - The reader hands out a batch only as far as its positions follow on from where it reads, without a gap (reading from `0n` expects `1n`).
  - When the first position isn't the next one, it reads `H`: `SELECT CAST(last_position AS CHAR) AS last_position FROM event_sourcing_collections WHERE name = ? AND kind = 'events' LOCK IN SHARE MODE`. That read waits for the append that holds the counter. It reads the batch again with `AND e.global_position <= ?` (`H`) and hands out every row: a gap below `H` is permanent (a deleted event, or a pool that was dropped and created again).
  - When that second read is empty, the table holds positions above its counter (drift): the reader logs a warning and hands out the rows of the first read.
  - Both reads must reach the server the appends run on. Behind a proxy that sends plain reads to a replica, a gap of the replica's lag would look permanent.
- `listCollections`: `SELECT name FROM event_sourcing_collections WHERE kind = 'events' AND schema_version = 2 AND name > ? ORDER BY name LIMIT ?`, in binary order; no catalog (`1146`) lists nothing.

**`connect()`**

- `createPool`, then probe with `SELECT @@wsrep_on AS wsrep`. An unknown variable (`1193`) means no Galera, and any other error ends the pool and fails the bootstrap.
- `wsrep = ON` (Galera) gives `globalOrder: 'best-effort'`, with a warning, because row locks aren't cluster-wide.

**Capabilities:** `{ atomicAppend: true, headers: true, globalOrder: 'gap-safe' }` on InnoDB, and `'best-effort'` on Galera. The [evidence](#mariadb) supports this with the source citation, the hybrid reader and `read-all-gap-safe` on 10.11, 11.4 and 11.8.

**Snapshots**

```sql
CREATE TABLE IF NOT EXISTS `<t>` (
  stream_id VARCHAR(255) NOT NULL, version INT NOT NULL, payload JSON NOT NULL, snapshot_id VARCHAR(40) NOT NULL,
  aggregate_id VARCHAR(255) NOT NULL, registered_on DATETIME(3) NOT NULL, aggregate_name VARCHAR(255) NOT NULL,
  latest VARCHAR(270) NULL,
  PRIMARY KEY (stream_id, version), UNIQUE KEY ux_latest (aggregate_name, latest)   -- NULLs are distinct
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
```

- `ensureCollection` registers a table that isn't v2 (3.x, or a migration that stopped) with `schema_version 1`, and warns. The store reads and writes `registered_on` according to the column's type: a 3.x `TIMESTAMP` gets a `Date`, a `DATETIME(3)` the UTC wall-time text. With `ddl: 'none'`, a missing catalog or table is logged with the statements to run, which are also in the exception's cause.
- `appendSnapshot` runs one attempt in a transaction:

  ```sql
  SET TRANSACTION ISOLATION LEVEL READ COMMITTED; START TRANSACTION;   -- pipelined; no gap locks
  SELECT version FROM `<t>` WHERE aggregate_name = ? AND latest = ? FOR UPDATE;   -- a version ≥ the new one: conflict
  UPDATE `<t>` SET latest = NULL, registered_on = registered_on WHERE stream_id = ? AND version = ?;   -- keeps a legacy ON UPDATE from firing
  INSERT INTO `<t>` (stream_id, version, payload, snapshot_id, aggregate_id, registered_on, aggregate_name, latest) VALUES (…);
  COMMIT;
  ```

  - *Amended:* a `1213` deadlock runs the attempt again, up to 10 attempts, after a jittered backoff of `random(0, min(100, 2 ** attempt))` ms. The duplicate checks of `ux_latest` lock neighbouring keys, so appends to different streams of one aggregate can deadlock.
  - Any `1062`, on `PRIMARY` or `ux_latest`, is a `SnapshotStoreVersionConflictException`, with the stream's highest version as its `latestVersion`.
- `getLastEnvelope`: `ORDER BY version DESC LIMIT 1`. `getManyLastSnapshotEnvelopes` joins each stream to its `MAX(version)`.
- `getLastEnvelopesForAggregate`: `WHERE aggregate_name = ? AND latest IS NOT NULL [AND latest < ?] ORDER BY latest DESC`, where `?` is `latest#<streamName>-<aggregateId>`, in binary order on a v2 table. The cursor is exclusive.

### 4. MongoDB

**Topology** (`lib/mongodb.topology.ts`, in `connect()`)

```ts
const hello = await client.db('admin').command({ hello: 1 });
const topology = hello.msg === 'isdbgrid' ? 'sharded' : hello.setName ? 'replica-set' : 'standalone';
Object.assign(this.capabilities, {
	'replica-set': { atomicAppend: true, headers: true, globalOrder: 'gap-safe' },
	sharded: { atomicAppend: true, headers: true, globalOrder: 'best-effort' }, // cross-shard visibility unproven
	standalone: { atomicAppend: false, headers: true, globalOrder: 'best-effort' }, // logger.warn once
}[topology]);
```

**Events**

- Documents: `{ _id: eventId, streamId, version, event, payload, aggregateId, occurredOn: Date, correlationId?, causationId?, globalPosition: Long, headers?, eventVersion? }`. Absent metadata is left out of the document, not stored as `null`; reads treat a `null` field as absent.
- Indexes: `{ streamId: 1, version: 1 }` unique, and `{ globalPosition: 1 }` unique.
- Validator (`validationLevel: 'strict'`, `validationAction: 'error'`): `{ $jsonSchema: { bsonType: 'object', required: ['globalPosition', 'streamId', 'version'], properties: { globalPosition: { bsonType: 'long' } } } }`.
- Creation: `createCollection(name, { validator, … })`, treating `NamespaceExists` (48) as success, then `createIndexes` (idempotent), then the catalog registration `updateOne({ _id: name }, { $setOnInsert: { kind: 'events' }, $set: { schemaVersion: 2 }, $max: { lastPosition: Long(maxPosition) } }, { upsert: true })`.
- *Amended:* the reads check the catalog only when a first batch is empty, and remember the collections it registers (`knownCollections`, a positive in-process cache). An insert can create a dropped collection again without its validator and indexes, so `ensureCollection` restores them for a registered collection (§1).
- `getStreamVersion` reads from the primary, whatever the client's read preference, so the version check doesn't read a stale head.

**`persistEvents` on a replica set or `mongos`.** The store runs its own bounded loop instead of `withTransaction`, which retries for 120 s. The total budget is 30 s, with a backoff of `random(0, min(100, 2 ** attempt))` ms. Each attempt:

```ts
session.startTransaction({
	readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary',
	maxCommitTimeMS: Math.max(1_000, deadline - Date.now()), // a commit can't outlast the budget
});
const counter = await catalog.findOneAndUpdate(
	{ _id: collection, kind: 'events' },
	{ $inc: { lastPosition: Long.fromNumber(n) } },
	{ session, returnDocument: 'after', projection: { _id: 0, lastPosition: 1 } },
); // null: abortTransaction, throw not-persisted (cause EventCollectionNotFoundException)
await events.insertMany(docs, { session, ordered: true });
await commitWithRetries(session); // UnknownTransactionCommitResult: retry the commit up to 3 times, then throw 'unknown'
```

- A `TransientTransactionError` aborts and retries the attempt.
- `11000` is classified per ADR 0001 amendment D3. *Amended:* a bulk write's error has no `keyPattern`, and the server doesn't escape the stream id in its message, so the store recognises the index by its name (`_id_`, `streamId_1_version_1`, `globalPosition_1`, `latest_unique`), and parses the key's fields only for an index with another name.
- When the budget runs out, the append fails with `not-persisted` and the last error as its cause.
- The snapshot store's transaction uses the same options and commit retries.

**`persistEvents` on a standalone server**

1. `findOneAndUpdate` with `$inc`, without a session, reserves the block.
2. An ordered `insertMany`.
3. On any failure, a compensating `deleteMany` removes the append's own events: its event ids within the positions it reserved (*amended:* not by `insertedCount`, which a failed bulk write doesn't always report). The outcome is then classified per D3; a failed delete is `unknown`, with both errors in an `AggregateError`. The reserved positions are burned.

**Reads**

- `readAll`: `find({ globalPosition: { $gte: Long.fromBigInt(from) } }).sort({ globalPosition: 1 }).limit(batch)`, one query per batch.
  - **`readConcern: { level: 'majority' }` on replica sets and `mongos`** (D31). Without it, a failover could roll back a position that was already yielded and hand it out again. The majority commit point advances in commit order, so the prefix property holds.
  - A standalone server uses the default read concern.
- Stream reads keep `batchCursor`.

**Snapshots**

- The index `{ aggregateName: 1, latest: 1 }` is unique with `partialFilterExpression: { latest: { $type: 'string' } }`, named `latest_unique`.
- An unflagged snapshot has **no** `latest` field (`$unset`).
- `appendSnapshot` on a replica set runs one transaction (unflag, then insert). On a standalone server it unsets the old flag, inserts, and re-flags the old snapshot if the insert fails.
- `getLastEnvelope` sorts by version, so a crash between the standalone writes loses nothing.

### 5. In-memory

- `positions: Map<collection, bigint>`.
- `persistEvents` has **no `await`** between the collection check, the `(stream, version)` check, the allocation and the push.
- Capabilities `{ atomicAppend: true, headers: true, globalOrder: 'gap-safe' }`.
- `connect()` keeps wiping the data, as in 3.x.

### 6. `migrate()`

#### API

The types live in core; each driver implements them for its event store and its snapshot store.

```ts
export interface MigrationOptions {
	dryRun?: boolean; // default false; writes nothing
	pools?: (IEventPool | undefined)[]; // undefined = the default pool; default: discovered by shape
	legacyTimeZone?: string; // PostgreSQL snapshots (3.x TIMESTAMP wall time): an IANA name, validated against pg_timezone_names; default: the process time zone
	repairOccurredOn?: boolean; // MariaDB events: restore occurred_on from the ULID when consistent; default true
	keepBackup?: boolean; // MariaDB copy-swap backups; default true
	lockTimeoutMs?: number; // default 10_000
	force?: boolean; // MongoDB: take over an expired or stale lease
	onProgress?: (progress: { collection: string; step: string; done?: number; total?: number }) => void;
}

export interface MigrationReport {
	dryRun: boolean;
	environment: { serverVersion: string; topology?: string; timeZones: { process: string; server?: string; session?: string } };
	collections: Array<{
		name: string;
		kind: 'events' | 'snapshots';
		from: 'absent' | 'v1' | 'v1-partial' | 'v2';
		action: 'migrate' | 'resume' | 'skip' | 'blocked';
		rows: number;
		bytes?: number;
		gappedStreams: { total: number; sample: Array<{ streamId: string; events: number; minVersion: number; maxVersion: number }> }; // sample ≤ 1000
		duplicateEventIds?: number;
		nonCrockfordEventIds?: number;
		caseVariantStreams?: number; // MariaDB: 3.x streams whose ids differ in case only (amended: given one id, not split)
		canonicalizedStreams?: { total: number; rows: number; sample: Array<{ streamId: string; variants: string[]; rows: number }> }; // MariaDB (amended), sample ≤ 1000
		occurredOnRepair?: { exact: number; precisionOnly: number; tzShifted: number; kept: number }; // MariaDB
		snapshotFlags?: { duplicateLatest: number; missingLatest: number };
		dependents?: string[]; // PostgreSQL views, triggers, publications; MariaDB triggers, foreign keys
		droppedIndexes?: string[];
		steps: Array<{ name: string; statement: string; lock: string; status: 'pending' | 'done' | 'skipped' }>;
		warnings: string[];
		blocking: string[];
	}>;
}

// On every driver's event store and snapshot store:
static migrate(config: Omit<XStoreConfig, 'driver'>, options?: MigrationOptions): Promise<MigrationReport>; // no Nest bootstrap needed
migrate(options?: MigrationOptions): Promise<MigrationReport>; // on a connected instance
```

- MongoDB takes `MongoDBMigrationOptions`, which adds `unsetEventDate?: boolean` (default `true`): `false` defers removing `eventDate` to a later run.
- The static `migrate()` drops the client timeouts that bound one operation from the config, because a numbering or an index build is one long operation: `query_timeout` on PostgreSQL, `timeoutMS` and `socketTimeoutMS` (options and connection string) on MongoDB. The PostgreSQL migration also sets `statement_timeout = 0` and a `work_mem` of 64 MB on its connection, and resets them before it releases it.

#### Common rules

- `migrate()` runs inspect, then a pure `plan(inspection, options)`, then execute. Each step is skipped when its postcondition already holds, so a second run reports `skip`.
- A dry run returns the exact resolved statements. DBAs who use `ddl: 'none'` run those.
- Numbering follows 3.x's order `(event_date, event_id, stream_id, version)` (MongoDB: `eventDate, _id`), adjusted so each stream keeps version order: rows are numbered by `(key, version)`, where `key` is the running maximum, over the row's stream ordered by version, of the row's rank in 3.x's order ([ADR 0001 D33](./0001-v4-core-api.md#amendments-store-contract)). The `ROW_NUMBER() OVER (ORDER BY event_date, event_id, stream_id, version)` expressions below are the rank `r`, not the final position.
- **Offline.** 3.x writers must be stopped. After the migration, a 3.x write fails loudly:
  - PostgreSQL: `event_date` is gone (`23502` / `42703`).
  - MariaDB: the column count of an event insert doesn't match (`1136`). The v2 snapshot table keeps the 3.x columns, so a 3.x snapshot write still succeeds.
  - MongoDB: the validator rejects it (`121`).
- `blocking` issues abort before any write:
  - PostgreSQL (*amended:* read from `pg_depend` and the privilege functions): a role that doesn't own the table; a missing catalog without `CREATE` on the schema, or an existing catalog without `SELECT`, `INSERT` and `UPDATE`; no `TEMPORARY` on the database; views and rules that use a column the migration drops or converts; policies, triggers, publication row filters and column lists, generated columns and other normal dependencies on `event_date`, or objects other than indexes, constraints and statistics on a converted column; foreign keys of other tables that reference the table (`TRUNCATE` fails); a table name that PostgreSQL truncated for 3.x (over 63 bytes, or 63 bytes without the `-events` / `-snapshots` suffix); an event table without `event_date`
  - MariaDB: a table without the columns of an event or snapshot table; triggers, or foreign keys from or to the table (a swap would leave them on the backup); a 3.x event table whose `<t>__es_v1` backup already exists; a `v1-partial` event table without a backup; a table name over 64 characters; the named lock of another migration of the table. *Amended:* missing privileges are not checked by the dry run; a step that lacks one fails with a hint that names the privileges, and the rerun continues (see the [evidence](#mariadb)). *Amended 2026-09-30:* the migration checks the swap's privileges before the copy (`probe-swap`, [amendment](#amendment-minimal-manual-mariadb-operations)).
  - MongoDB: a server older than 5.0; a sharded collection, or one whose sharding the user may not read; non-string `_id`s; events without an `eventDate` string when the collection is numbered by `eventDate`; a validator of another shape; a missing unique `{ streamId: 1, version: 1 }` index; a live lease of another run; privileges that the pending steps need, read with `connectionStatus`

**Gapped streams** (PostgreSQL and MariaDB; MariaDB groups by `CAST(stream_id AS BINARY)`, the way schema v2 compares stream ids):

```sql
SELECT stream_id, COUNT(*) AS events, MIN(version) AS min_version, MAX(version) AS max_version
FROM <t> GROUP BY stream_id HAVING MIN(version) <> 1 OR MAX(version) <> COUNT(*) ORDER BY stream_id LIMIT 1000;
-- plus SELECT COUNT(*) FROM (… the same GROUP BY and HAVING …) AS g for the total
```

*Amended:* MongoDB streams the `{ streamId: 1, version: 1 }` index once, `find({}, { projection: { _id: 0, streamId: 1, version: 1 }, sort: { streamId: 1, version: 1 }, hint: { streamId: 1, version: 1 } })` in batches of 10,000, a covered read, and counts the events, minimum and maximum version per stream in the client. The `$group` form took 353 s at 10 million events in the spike.

#### PostgreSQL events: in place, one transaction per table

*Amended by the Wave 0 spike and the driver:* the table is rewritten in place, in one transaction, instead of a backfill `UPDATE`: a numbered temporary copy, `TRUNCATE`, then the rows inserted again. The spike measured 19.5 s instead of 200 s for a million rows, with 6.5 times less WAL and no bloat (see the [evidence](#postgresql)).

This keeps the table's OID, so grants, publications and views that don't use a changed column survive. The migration runs on one dedicated client, which first sets `statement_timeout = 0` and `work_mem = '64MB'` for the inspection and `VACUUM` (reset before the client goes back to the pool). If the catalog is missing, it is created first, in its own transaction under its advisory lock. Then:

```sql
SELECT pg_try_advisory_lock(hashtext('ocoda:migrate'), hashtext(format('%I.%I', current_schema(), '<t>')));
                                                    -- false: blocked, "another migration of this table is running"
BEGIN ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '<lockTimeoutMs>ms'; SET LOCAL statement_timeout = 0;
SET LOCAL work_mem = '64MB'; SET LOCAL maintenance_work_mem = '256MB';
LOCK TABLE "<t>" IN ACCESS EXCLUSIVE MODE;           -- 55P03: ROLLBACK, blocked, "other sessions still use the table"
-- re-inspect under the lock; a changed state: ROLLBACK, blocked
CREATE TEMPORARY TABLE es_migrate_<hash> ON COMMIT DROP AS    -- number: written in position order
SELECT <columns>, row_number() OVER (ORDER BY stream_key, version) AS global_position
FROM (
  SELECT *, max(legacy_rank) OVER (PARTITION BY stream_id ORDER BY version ROWS UNBOUNDED PRECEDING) AS stream_key
  FROM (
    SELECT <columns>, row_number() OVER (ORDER BY event_date, event_id, stream_id, version) AS legacy_rank
    FROM "<t>"
  ) ranked
) keyed;
ALTER TABLE "<t>" ADD COLUMN IF NOT EXISTS global_position BIGINT, ADD COLUMN IF NOT EXISTS headers JSONB,
  ADD COLUMN IF NOT EXISTS event_version INTEGER, ALTER COLUMN <each VARCHAR column> TYPE TEXT;
DO $migrate$ BEGIN                                    -- refuses to run without the numbered copy (autocommit)
  IF to_regclass('pg_temp.es_migrate_<hash>') IS NULL THEN RAISE EXCEPTION '…'; END IF;
  TRUNCATE "<t>";
END $migrate$;
ALTER TABLE "<t>" ALTER COLUMN global_position SET NOT NULL, DROP COLUMN event_date;   -- drops every event_date index
INSERT INTO "<t>" (<columns>, global_position) [OVERRIDING SYSTEM VALUE]
SELECT <columns>, global_position FROM es_migrate_<hash>;   -- no sort: the copy is in position order
CREATE UNIQUE INDEX IF NOT EXISTS "<deriveIndexName(t, 'global_position')>" ON "<t>" (global_position);
INSERT INTO event_sourcing_collections … ON CONFLICT (name) DO UPDATE …;   -- the registration of §2
COMMIT;
VACUUM (ANALYZE, PARALLEL 0) "<t>";                   -- after the commit: a failure is a warning in the report
SELECT pg_advisory_unlock(hashtext('ocoda:migrate'), hashtext(format('%I.%I', current_schema(), '<t>')));
```

- `<columns>` are every column but `event_date` and `global_position`, including columns a user added to the 3.x table; generated columns are computed again, and identity columns keep their values (`OVERRIDING SYSTEM VALUE`). The numbering is D33's rule.
- The migration lock key names the schema, so the same pool in two schemas migrates in parallel; `migrate()` runs once per schema.
- The dry run lists `dependents` (views and rules, triggers, publications, foreign keys that reference the table) and `droppedIndexes` (every index on `event_date`, also through an expression or a predicate), and warns about what a subscriber of a publication receives (a `TRUNCATE`, then an insert of every row), about triggers that fire for the `TRUNCATE` and the inserts, and about the free disk: 3 times the table.

#### PostgreSQL snapshots (own transaction, `ACCESS EXCLUSIVE`)

The same migration lock, transaction settings, table lock and re-inspection as the events, then:

1. Drop every non-unique index on `(aggregate_name, latest)`, found by its columns.
2. Unflag every snapshot below the highest version of its stream: `UPDATE s SET latest = NULL WHERE s.latest IS NOT NULL AND EXISTS (SELECT 1 FROM s n WHERE n.stream_id = s.stream_id AND n.version > s.version)`.
3. Flag the highest version of every stream: `UPDATE s SET latest = 'latest#' || s.stream_id WHERE s.latest IS DISTINCT FROM 'latest#' || s.stream_id AND NOT EXISTS (SELECT 1 FROM s n WHERE n.stream_id = s.stream_id AND n.version > s.version)`.
4. `ALTER COLUMN … TYPE TEXT` for the text columns, `ALTER COLUMN latest TYPE TEXT COLLATE "C"`, and `ALTER COLUMN registered_on TYPE TIMESTAMPTZ USING registered_on AT TIME ZONE '<validated tz>'`. The time zone is an escaped literal, because a utility statement takes no bind parameters. When it is UTC, the step runs `SET LOCAL TimeZone = 'UTC'` and no `USING`, which skips the rewrite on PostgreSQL 12 and later. Otherwise the dry run warns that the table and its indexes are rewritten under the lock.
5. Create the unique partial latest index.
6. Register the table in the catalog (`snapshots`, 2), commit, then `VACUUM (ANALYZE, PARALLEL 0)`.

#### MariaDB events: copy and swap, per table

The copy never `UPDATE`s a 3.x row, so the `ON UPDATE` hazard can't fire. The `TIMESTAMP → DATETIME(3)` change needs a copy anyway, and the swap leaves a backup.

The migration connects on a connection of its own with `socketTimeout: 0`: a copy runs for minutes without a byte on the socket. It sets the session, takes the named lock, then inspects and plans the table under the lock, so a run continues where the previous one stopped. Every step is one statement in autocommit. A failed step destroys the connection, which releases the lock and the session settings.

```sql
-- session (amended: REPEATABLE READ pinned; the fragment settings on Galera only)
SET SESSION time_zone = '+00:00', lock_wait_timeout = <s>, innodb_lock_wait_timeout = <s>, max_statement_time = 0,
  tx_isolation = 'REPEATABLE-READ'[, wsrep_trx_fragment_unit = 'bytes', wsrep_trx_fragment_size = 67108864];
CREATE TABLE IF NOT EXISTS event_sourcing_collections (…);
-- amended: a hashed lock name, and a taken lock raises 1242 (blocked), which also stops the mariadb client
SELECT IF(GET_LOCK(CONCAT('ocoda:migrate:', SHA1(CONCAT(DATABASE(), '.', '<t>'))), 0) = 1, 1, (SELECT 1 UNION SELECT 2)) AS acquired;
DROP TABLE IF EXISTS `<t>__es_v2`;                     -- leftover of a crashed run (derived names are hashed when > 64 characters)
CREATE TABLE `<t>__es_v2` ( …the v2 DDL… );
-- amended 2026-09-30: the swap's privileges (ALTER, DROP, CREATE, INSERT), checked before the copy
RENAME TABLE `<t>__es_v2` TO `<t>__es_vp`, `<t>__es_vp` TO `<t>__es_v2`;
SET SESSION unique_checks = 0, foreign_key_checks = 0;  -- amended: a bulk load into the empty copy
INSERT INTO `<t>__es_v2` (stream_id, version, event, payload, event_id, aggregate_id, occurred_on,
                          correlation_id, causation_id, global_position)
-- amended 2026-09-30: one stream id per 3.x stream, the id of its lowest version (and that version's aggregate id
-- for a renamed row, when the two differ in case only)
SELECT k.first_stream_id, k.version, k.event, k.payload, k.event_id, <aggregateIdExpr>, <occurredOnExpr>,
       k.correlation_id, k.causation_id, ROW_NUMBER() OVER (ORDER BY k.ord_key, k.version) AS global_position
FROM (
  SELECT r.*, MAX(r.ord_rank) OVER w AS ord_key,
         FIRST_VALUE(r.stream_id) OVER w AS first_stream_id, FIRST_VALUE(r.aggregate_id) OVER w AS first_aggregate_id
  -- w: (PARTITION BY r.stream_id ORDER BY r.version ROWS UNBOUNDED PRECEDING), written out three times
  FROM (
    SELECT o.<3.x columns>, CAST(UNIX_TIMESTAMP(o.occurred_on) AS SIGNED) AS occurred_ts,
           o.event_id REGEXP '<ULID_TIME_PATTERN>' AS ulid_valid, <ulidMs(o.event_id)> AS ulid_ms,
           ROW_NUMBER() OVER (ORDER BY o.event_date, o.event_id, o.stream_id, o.version) AS ord_rank   -- source collation = 3.x order
    FROM `<t>` o
  ) r
) k;
SET SESSION unique_checks = 1, foreign_key_checks = 1;
RENAME TABLE `<t>` TO `<t>__es_v1`, `<t>__es_v2` TO `<t>`;   -- atomic; 3.x inserts now fail with 1136
-- catch up the rows 3.x wrote between the copy's read and the RENAME (normally none; reported as a warning):
INSERT INTO `<t>` (…) SELECT …, b.base + ROW_NUMBER() OVER (ORDER BY k.ord_key, k.version)
FROM ( …the same ranking and key over `<t>__es_v1` o LEFT JOIN `<t>` n
         ON n.stream_id = CONVERT(o.stream_id USING utf8mb4) COLLATE utf8mb4_bin AND n.version = o.version
       WHERE n.stream_id IS NULL
       -- amended 2026-09-30: and not under the id of its stream's lowest version either (a lookup in the backup's
       -- primary key, for the rows the first join misses); inserted under that id
       … ) k
CROSS JOIN (SELECT COALESCE(MAX(global_position), 0) AS base FROM `<t>`) b;
INSERT INTO event_sourcing_collections (…) SELECT '<t>', 'events', 2, COALESCE(MAX(global_position), 0) FROM `<t>`
  ON DUPLICATE KEY UPDATE schema_version = 2, last_position = GREATEST(last_position, VALUES(last_position));
-- keepBackup false: DROP TABLE IF EXISTS `<t>__es_v1`; otherwise the report prints that statement as a warning
SELECT RELEASE_LOCK(CONCAT('ocoda:migrate:', SHA1(CONCAT(DATABASE(), '.', '<t>')))) AS released;
```

- **The copy is the fence.** Under `REPEATABLE READ` the `INSERT … SELECT` takes a shared lock on every row it reads, so a 3.x write waits and fails with `1205` while reads continue; a `READ COMMITTED` `INSERT … SELECT` would also be refused by a binary log in `STATEMENT` format. The locks take about 3.4 MB of lock memory per million rows. When they outgrow the buffer pool (`1206`), the failure hint suggests a bigger buffer pool, or the dry run's statements by hand with a `READ COMMITTED` copy (the catch-up copies what 3.x wrote meanwhile).
- **Crash recovery.** Before the `RENAME`, the state is still `v1`, and a rerun drops the leftover copy. After the `RENAME`, the state is `v1-partial` (the backup exists and there is no catalog row), and a rerun does the catch-up and registers the table. A `v2` table without its catalog row only gets registered; with `keepBackup: false`, a registered table whose backup still exists only gets the backup dropped.
- **Numbering** follows D33 in the copy and in the catch-up. The partition compares stream ids in the 3.x table's collation, which usually ignores case: ids that differ in case only are one 3.x stream for the key. Ties break by version. *Amended 2026-09-30:* the stream is also one stream in schema v2, under the id of its lowest version ([amendment](#amendment-minimal-manual-mariadb-operations)).
- **`occurredOnExpr`** repairs 3.x's `TIMESTAMP(0)` truncation and a Node.js time zone that differs from the server's; the session is UTC, so a `TIMESTAMP` reads as UTC wall time:

  ```sql
  CASE WHEN k.ulid_valid = 1 AND ABS(k.occurred_ts - k.ulid_ms DIV 1000) <= 50400 AND MOD(k.occurred_ts - k.ulid_ms DIV 1000, 900) = 0
       THEN FROM_UNIXTIME(k.ulid_ms DIV 1000) + INTERVAL (k.ulid_ms MOD 1000) * 1000 MICROSECOND
       ELSE k.occurred_on END   -- just k.occurred_on when repairOccurredOn is false
  ```

  - `ulid_ms` decodes the first 10 characters of `event_id` as Crockford base32, with a generated 10-term sum of `(LOCATE(UPPER(SUBSTRING(id, i, 1)), '0123456789ABCDEFGHJKMNPQRSTVWXYZ') - 1) * 32^(10 - i)`, where the powers are integer constants. A JavaScript twin checks it in the specs.
  - *Amended:* `ULID_TIME_PATTERN` is `^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{10}[0-9A-Za-z]{16}$`. Only the time part must be Crockford base32, as 3.x accepted ids, so ids like `…ILOU` are repaired too.
  - The dry run reports the four counts (`exact`, `precisionOnly`, `tzShifted`, `kept`), computing the decoded time once per row in a derived table: about 0.75 minutes per million rows. A migration doesn't compute them.
- **The dry run** writes nothing: it skips the session settings, the named lock and the catalog. For a `v1` table it reports:
  - `rows` and `bytes`;
  - `gappedStreams`, *amended 2026-09-30:* grouped by the 3.x stream (the table's collation), under the id the migration gives it;
  - `caseVariantStreams`: `GROUP BY stream_id HAVING COUNT(DISTINCT CAST(stream_id AS BINARY)) > 1`, and *(amended)* `canonicalizedStreams`, the ids the migration replaces;
  - `duplicateEventIds`, and `nonCrockfordEventIds` (ids that aren't canonical ULIDs);
  - `dependents` (triggers, and foreign keys from or to the table);
  - `droppedIndexes`: every index but `PRIMARY`. An index other than 3.x's `(event_date, event_id)` gets a warning that the migrated table doesn't have it.
- **Galera** (`wsrep_on`): the report's `topology` is `'galera'`. It warns to run the migration against one node, because the named lock is per node, and that every node needs the copy's free space. *Amended 2026-09-30:* the fragment size is 64 MiB, or half the node's `wsrep_max_ws_size` when that is smaller (1 MiB at least).
- **Failure hints** name the remedy for a lock wait (`1205`: a session still uses the table; *amended:* with `PROCESS`, the sessions with an open transaction, from `INNODB_TRX`), a full disk or `tmpdir` (`1021`, `1114`, `Temp file write failure`: the sorts need about 1.5 times the event table in `tmpdir`), a Galera write set over `wsrep_max_ws_size`, a missing privilege (`1044`, `1142`, `1227`: the user needs `SELECT`, `INSERT`, `UPDATE`, `CREATE`, `ALTER` and `DROP`) and a lost connection (wait until `IS_USED_LOCK(<name>)` returns `NULL`, because the server may still run the step). Every other failure says to run the migration again.

#### MariaDB snapshots (in place, session `time_zone` `'+00:00'`)

The same session, catalog and named lock as the events, then (*amended:* the conversion first, so the flag repairs compare stream ids in binary and the `ON UPDATE` attribute is gone before any `UPDATE`):

0. *Amended 2026-09-30,* while the columns aren't converted: `canonicalize`, one `UPDATE s JOIN (<one row per 3.x stream with the id it takes>) c ON s.stream_id = c.stream_key SET …, s.registered_on = s.registered_on WHERE CAST(s.stream_id AS BINARY) <> CAST(c.stream_id AS BINARY)`, which gives every snapshot of a 3.x stream the stream id of the stream's events, or of its lowest snapshot ([amendment](#amendment-minimal-manual-mariadb-operations)).
1. Unless the columns are converted and no other index on `(aggregate_name, latest)` is left: `ALTER TABLE s CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, MODIFY stream_id VARCHAR(255) NOT NULL, MODIFY aggregate_id VARCHAR(255) NOT NULL, MODIFY registered_on DATETIME(3) NOT NULL, MODIFY aggregate_name VARCHAR(255) NOT NULL, MODIFY latest VARCHAR(270) NULL, DROP INDEX <each non-unique index on (aggregate_name, latest)>, ALGORITHM=COPY, LOCK=SHARED`. `MODIFY` removes the `ON UPDATE` attribute, and the UTC session converts `registered_on` to UTC wall time.
2. Unflag the superseded snapshots: `UPDATE s JOIN (SELECT stream_id, MAX(version) AS version FROM s GROUP BY stream_id) m ON s.stream_id = m.stream_id SET s.latest = NULL, s.registered_on = s.registered_on WHERE s.latest IS NOT NULL AND s.version < m.version`. The derived table avoids error `1093`.
3. Flag the highest version of every stream, through the same join on `s.version = m.version`: `SET s.latest = CONCAT('latest#', s.stream_id), s.registered_on = s.registered_on WHERE s.latest IS NULL OR s.latest <> CONCAT('latest#', s.stream_id)`.
4. Unless it exists: `ALTER TABLE s ADD UNIQUE KEY ux_latest (aggregate_name, latest), ALGORITHM=INPLACE, LOCK=SHARED`.
5. Register the table in the catalog (`snapshots`, 2), then release the lock.

The dry run reports `snapshotFlags` (*amended:* per 3.x stream) and the streams whose flag is not on their highest version, and *(amended)* `caseVariantStreams` and `canonicalizedStreams`. It warns that on servers created before 10.10, 3.x may already have overwritten the `registered_on` of superseded snapshots, which can't be repaired. It also warns that a snapshot a 3.x process wrote in another time zone than the server's stays off by that offset, because snapshots carry no id to take the time from. On Galera it warns that the `ALTER TABLE` runs on every node at once (total order isolation) and holds the table's writes on the whole cluster. The v2 snapshot table keeps the 3.x columns in their 3.x order, so a 3.x snapshot write still succeeds after the migration, with `registered_on` off by the offset of the 3.x process.

#### MongoDB events: in place, fenced first

A first look plans each collection without a lease; a collection with work to do is planned again under its lease. The steps:

1. **Lease:** `insertOne({ _id: 'lock:migrate:<t>', kind: 'lock', owner, expiresAt: now + 10 min })` into the catalog. A live lease of another run means `blocked`; an expired one is taken over, and so is any with `force`. The run renews its lease every minute, and stops with `blocked` before its next step when another run took the lease over. The lease is released at the end, also when a step fails; a crashed process leaves it until it expires.
2. **Fence:** `collMod` with the v2 validator, waiting at most `lockTimeoutMs` for the collection lock (a timeout reports `blocked`). Every 3.x insert now fails with `121`. Nothing updates existing documents until step 3, whose updates make them valid.
3. **Numbering** (*amended:* on the server, as the Wave 0 spike recommended, instead of a client-side keyset): one aggregation with `allowDiskUse: true`, which applies D33 and merges the positions into the collection. A 3.x collection is always numbered, even one that looked empty, since a 3.x writer may insert before the fence.

   ```js
   [
     // the rank r in 3.x's order, per collection (D35):
     { $setWindowFields: { sortBy: { _id: 1 }, output: { r: { $documentNumber: {} } } } },   // every _id a canonical ULID
     // otherwise: { $project: { …, rankKey: { $concat: ['$eventDate', '#', '$_id'] } } }, then sortBy: { rankKey: 1 }
     { $setWindowFields: { partitionBy: '$streamId', sortBy: { version: 1 },
         output: { k: { $max: '$r', window: { documents: ['unbounded', 'current'] } } } } },
     { $set: { orderKey: { $add: [{ $multiply: [{ $toLong: '$k' }, 2 ** 31] }, { $toLong: '$version' }] } } },
     { $setWindowFields: { sortBy: { orderKey: 1 }, output: { position: { $documentNumber: {} } } } },
     { $project: { _id: 1, globalPosition: { $toLong: '$position' } } },
     { $merge: { into: '<t>', on: '_id', whenMatched: 'merge', whenNotMatched: 'fail' } },
   ]
   ```

   - `$documentNumber` takes one sort key, so `(k, version)` is one 64-bit key, and it returns a 32-bit integer, which `$toLong` widens for the validator (`121` otherwise). `$toLong` on the version keeps a version stored as a double exact.
   - For canonical ULIDs, ranking by `_id` equals 3.x's `(eventDate, _id)` order, because 3.x derived `eventDate` from the id, and the `_id` index gives that order. A collection with any other id takes the `$concat` key, whose ranking sorts on disk.
   - It is deterministic, so a rerun computes identical positions.
4. `createIndex({ globalPosition: 1 }, { unique: true })`.
5. Upsert the catalog document (`schemaVersion: 2`, `$max` of `lastPosition`). **This is the commit point: 4.0 can run from here.**
6. Clean up: drop the indexes whose key contains `eventDate` (found by key pattern, each waiting at most `lockTimeoutMs`), then remove `eventDate` in `updateMany` batches of 10,000 events along the `_id` index. Resumable; `unsetEventDate: false` defers the removal to a later run.
7. Release the lease.

`migrations/4.0.mongosh.js` holds the same steps for the default pools (`events`, `snapshots`), for review and for stores that run with `ddl: 'none'`. It first checks what `migrate()` checks, and changes nothing when a check fails.

#### MongoDB snapshots

Under the same lease:

1. `updateMany({ latest: { $type: 'null' } }, { $unset: { latest: '' } })` (*amended:* `{ latest: null }` would also match the snapshots without the field).
2. Repair the flags of every stream that has several, none, or one that isn't on its highest version: a `$group` finds them, then, per stream, the highest version is read again, the lower versions are unflagged and the highest is flagged. A 4.0 store may append snapshots meanwhile; a snapshot appended between that read and the flag leaves two flags, on which the index build fails, and a second run repairs it.
3. Create `latest_unique`, partial on `{ latest: { $type: 'string' } }`. On a server that refuses a second index on the same key, the 3.x index is dropped first.
4. Drop the 3.x index on `{ aggregateName: 1, latest: 1 }`, found by its key (`aggregateName_1_latest_1` by default).
5. Register the collection in the catalog (`kind: 'snapshots'`, `schemaVersion: 2`).

#### Runbook

Published in each `integrations/<db>` docs page and in the 4.0 guide's data migration section:

1. Take a backup.
2. Deploy nothing yet. Run `XEventStore.migrate(config, { dryRun: true })` and `XSnapshotStore.migrate(config, { dryRun: true })`, and review `blocking`, `gappedStreams` and the time zone facts.
3. **Stop every 3.x instance.**
4. Run `migrate()` for the events, then for the snapshots. A `blocked` collection is reported, not thrown: stop the cutover while any collection is `blocked`, and run again until every one reports `skip`.
5. Deploy 4.0.
6. MariaDB: drop the `__es_v1` backups when satisfied, after the snapshots are migrated: *(amended)* a run with `keepBackup: false` drops them.

A gapped stream conflicts on its next append in 4.0. ADR 0001 gives the fix: 4.x `loadFromEnvelopes`, or an append with the actual head as the expected version.

## Owner decisions

**DECIDED** (2026-09-30, owner): keep `utf8mb4_bin` and `event_sourcing_collections`, and the 3.x → 4 MariaDB migration must need minimal manual MariaDB operations. Changing either decision later would cost users a second data migration. The second part is the [amendment below](#amendment-minimal-manual-mariadb-operations).

1. **MariaDB binary collation (`utf8mb4_bin`) for v2 tables.** *Decided: binary.*
   - It makes stream ids case-sensitive, like PostgreSQL, MongoDB and in-memory, and gives a deterministic binary cursor order.
   - Users whose 3.x MariaDB relied on case-insensitive ids (`Acc-1` = `acc-1`) would see those streams split. The migration gives each such 3.x stream one stream id instead ([amendment](#amendment-minimal-manual-mariadb-operations)); the application uses those ids afterwards. The dry run lists them (`caseVariantStreams`, `canonicalizedStreams`).
   - Reversing it later needs another table rebuild.
   - *Rejected alternative:* keep the server's default collation per table. That keeps the case-insensitive semantics and makes MariaDB's cursor order locale-dependent.
2. **Catalog name `event_sourcing_collections`**, one table or collection per schema or database. *Decided: this name.*
   - Renaming it after 4.0 users have migrated needs a migration.
   - *Rejected alternative:* an `ocoda_`-prefixed name.

### Amendment: minimal manual MariaDB operations

An audit of `migrate()` and the runbook for every step that made a MariaDB user work by hand, with what changed:

| Manual step before | Now |
| --- | --- |
| A 3.x stream whose rows have ids that differ in case only (`Acc-1` version 1, `acc-1` version 2, which the 3.x primary key allows) split into two v2 streams, one of them gapped; the user had to merge them with SQL or append after the conflict | The migration gives every such stream one stream id (below) |
| A missing `ALTER` failed the swap after the whole copy, which the rerun copied again | The `probe-swap` step, before the copy, renames the empty copy and back in one statement, which needs the swap's privileges. A missing `DROP` already fails `drop-copy`, before the copy too. The dry run still can't check privileges (it writes nothing, and `PREPARE` checks `CREATE` and `UPDATE`, but not `ALTER`, `DROP` or `RENAME`: measured on 10.11) |
| A lock wait timeout said "a session still uses the table" | With `PROCESS`, the error names the sessions with an open transaction (`INNODB_TRX`, oldest first) |
| On Galera, a `wsrep_max_ws_size` below 64 MiB failed the copy; the user had to raise it or run the statements by hand with a smaller fragment size | The session's fragment size is 64 MiB or half the node's `wsrep_max_ws_size`, whichever is smaller (1 MiB at least) |
| Dropping the backups was a `DROP TABLE` per event table | A second run with `keepBackup: false` drops them (the planner already did; now documented) |

What stays manual, because automating it isn't safe: stopping the 3.x instances (the migration can't tell a 3.x writer from another client); triggers and foreign keys on a 3.x table (their bodies are written for the 3.x schema); a leftover `__es_v1` backup next to a 3.x table (which of the two holds the data is the user's call); running against one Galera node (`GET_LOCK` isn't cluster-wide, and a lease in the catalog would change its schema); the `tmpdir` and buffer pool sizes. `ddl: 'auto'` stays zero-touch: none of this concerns it.

**One stream id per 3.x stream.** The 3.x tables compare stream ids in their collation (usually case-insensitive; with `uca1400_ai_ci` also accent-insensitive; and in the usual `PAD SPACE` collations trailing spaces don't count), so one 3.x stream can hold rows whose ids differ in that way. Schema v2 compares in binary.

- **Events.** Every row of a 3.x stream (the D33 window's partition, in the 3.x collation) takes the stream id of the stream's lowest version, `FIRST_VALUE(r.stream_id) OVER (PARTITION BY r.stream_id ORDER BY r.version …)`, in the same window as the D33 key, so it costs no extra sort. A row whose stream id changes also takes the lowest version's aggregate id, when the two compare equal in the 3.x collation. The lowest version is the stream's creation: its first event holds the id the aggregate was created with, and it is unique within the 3.x stream (the primary key), so the choice is deterministic. The catch-up gives the late rows the same id: a backup row is in the new table already when its version is there under its own id or under the id of its stream's lowest version, looked up in the backup's primary key only for the rows the first lookup misses. So a rerun after a crash never copies a renamed row twice.
- **Snapshots.** A `canonicalize` step before `convert`, one `UPDATE … JOIN` while the table still compares in its 3.x collation, gives every snapshot of a 3.x stream the stream id of the stream's events: the id of the lowest event version in the pool's 3.x event rows (the 3.x event table, or its `__es_v1` backup once the events are migrated), two primary key lookups per snapshot stream. Without such rows (no event table, the backup dropped, or stream ids in another collation than the snapshots', which the report warns about), it takes the id of the lowest snapshot version. A snapshot whose id changes also takes the aggregate id (of the events' lowest version, or of the lowest snapshot) and the aggregate name (the start of the new id, or of the lowest snapshot), each when they compare equal in the 3.x collation. The primary key compares the old and the new id as equal, so no two rows collide; the step assigns `registered_on` to itself (the `ON UPDATE` hazard); the flag repairs after the conversion leave one flag, on the highest version. Aligning with the events keeps the snapshots and the events of an aggregate on one id: otherwise a snapshot taken after the casing changed would keep the later casing, 4.0 wouldn't find it for the aggregate, and a new snapshot would make `loadAll` list the aggregate twice.
- **Crash safety.** The copy and the catch-up are single statements, as before. The snapshot `UPDATE` is one statement too, planned while the columns aren't converted; a rerun finds every stream on its id already and changes nothing.
- **Report.** `caseVariantStreams` counts the 3.x streams whose ids differ in case only (events and, now, snapshots). The new `canonicalizedStreams: { total, rows, sample }` (sample ≤ 1000, binary order) lists per stream the id it takes (`streamId`), the ids it replaces (`variants`) and the rows that change, and a warning shows a few (`acc-1 -> Acc-1`). `gappedStreams` and `snapshotFlags` group by the 3.x stream, so a case-variant stream no longer shows up as gapped.
- **After the migration** the application must use those ids, which the runbook and the 4.0 guide say. The alternative, the highest version's casing, would follow an application that changed its casing (a renamed `streamName`) but not one that took ids from its input; neither rule fits every application, and the lowest version is the one the aggregate was created with.
- **Evidence.** `mariadb.migration.spec.ts`: a three-casing stream in the corpus (dry run, report, positions, the ids and aggregate ids of every row, reads through the store), a late row in a case-variant stream caught up after a crash after the swap, crash injection after every step (events and snapshots), snapshots aligned with the events before and after the event migration (and `loadAll` listing each aggregate once), and the fallbacks with their warnings; `migrations/4.0.sql` run as a file gives what `migrate()` gives. The cross-version fixture: 3.0.2 writes `account-Acc-1` version 1, `account-acc-1` version 2, and a snapshot under `account-acc-1`; after `migrate()` all three read under `account-Acc-1`.

## Evidence

Each driver's schema v2 PR fills its subsection. Until then a driver claims nothing beyond `'best-effort'`.

- **S1, position stress:** 8 writers × 200 appends of 1–3 events, with a tailing keyset reader that asserts exactly-once delivery and strictly increasing positions, plus a deliberately broken reserve → sleep → commit variant that must be caught. Reports appends per second per pool.
- **S2, migration timing:** synthetic v1 tables of 1 and 10 million rows. Reports the duration, the locks held, peak disk use and WAL or binlog volume, for the runbook's "minutes per million rows".
- **CI:** `read-all-gap-safe` on every CI version of the database, the migration specs (§6, including crash injection) and the cross-version fixture (3.0.2 writes, 4.0 migrates, reads and appends).

### PostgreSQL

**Verdict:** `{ atomicAppend: true, headers: true, globalOrder: 'gap-safe' }`, claimed by the PostgreSQL schema v2 PR. Two techniques differ from §2 and §6 as first written (both are amended above), as the Wave 0 spikes recommended: the append is one data-modifying CTE (the counter `UPDATE … RETURNING`, then the `unnest` insert with positions `last_position - n + ordinality`) inside `BEGIN ISOLATION LEVEL READ COMMITTED … COMMIT`, and the event migration rewrites the table in place (numbered temporary copy, `TRUNCATE`, re-insert) instead of the backfill `UPDATE`. Both keep the properties the design relies on: the counter update is the first write and its row lock lasts until the transaction ends, and the table keeps its OID.

**S1, position stress** (PostgreSQL 14.20, stock settings, in a 6-CPU colima VM on Apple silicon; data on tmpfs (A) and on disk with fsync (B)):

- The counter-row design delivered every event exactly once, in strictly increasing positions, with no holes and the counter equal to `MAX(global_position)`, in every run: 29 correctness runs per environment of the 4-statement append of §2 as first written (1 and 4 pools, 8 writers × 200 appends of 1–3 events, 20 % of the appends on one hot stream, two tailing keyset readers with batches of 100 and 10) and two 40,000-append soaks of it with over 15,000 rolled-back conflicts each. The CTE variant ran 5 times per environment in a `READ COMMITTED` transaction (the implemented variant) and 6 times in autocommit, and one 40,000-append soak ran on the autocommit variant only. The implemented variant also passed `CONFORMANCE_REPEAT=50` of the concurrency cases locally and `read-all-gap-safe` on every CI version (below). A rolled-back append returned its positions every time.
- The detector fires: a reserve → sleep ≤ 5 ms → commit variant was caught in 16 of 16 runs (≤ 1 ms: 6 of 6, also without holes), and a `nextval()` sequence without sleep in 16 of 16.
- Explicit `READ COMMITTED` matters: under a `REPEATABLE READ` server default, a plain `BEGIN` got about 1.5 serialization failures per append, and 1 (A) and 5 (B) appends failed after 16 attempts; with the explicit level, none.
- Why it holds (PostgreSQL `REL_14_STABLE`, `xact.c` 2200–2268): `CommitTransaction` writes the commit record, then leaves the proc array (the commit becomes visible to new snapshots), and only then releases its locks; a waiter on the counter row (`heap_update` → `XactLockTableWait`) wakes after that, so commit visibility follows position order. The abort path has the same order.
- `ExpectedVersion.Any` under sustained contention on one stream: 12 of about 8,000 hot appends used all 16 attempts in a soak (documented: retry in the application).

Appends per second per pool, 1–3 events per append, 8 writers unless noted (median of 3 runs):

| Variant | A (tmpfs) | B (disk) |
| --- | --- | --- |
| §2 as first written (4 statements) | 663 | 324 |
| CTE in a `READ COMMITTED` transaction (implemented) | 1,033 | 390 |
| The driver's `appendEvents` (with the version read), PostgreSQL 14.20 / 17.8, 1 pool × 1 writer | 331 / 317 | – |
| The same, 1 pool × 8 writers | 1,053 / 1,057 | – |
| The same, 4 pools × 8 writers, per pool | 534 / 502 | – |

**S2, migration** (the same machine). The spike's rows: the synthetic v1 table has the 3.0.2 DDL, 10 events per stream interleaved over two years, 100–150-byte payloads. The driver rows: 100,000 events with the 3.0.2 DDL, 5 per stream interleaved, about 330-byte payloads, a 70 MB table (56 MB heap); 20,000 snapshots, 14 MB, converted from `Europe/Brussels` (a rewrite). Three runs each; the driver's figures are for the statements the review fixes ship (the D33 numbering of ADR 0001, three window sorts, and a reinsert that keeps the order the copy was written in, without a sort).

| Rows, procedure | Environment | Total | Under `ACCESS EXCLUSIVE` | WAL | Table after (heap / indexes) |
| --- | --- | --- | --- | --- | --- |
| 1M, §6 backfill `UPDATE` as first written (spike) | B | 200.1 s | 188.8 s | 3,350 MB | 610 / 133 MB (from 300 / 135) |
| 1M, rewrite with the spike's statements (one window sort, sorted reinsert) | B | 19.5 s | 18.2 s | 516 MB | 300 / 100 MB |
| 100k, the driver's `migrate()`, PostgreSQL 14.20 (shared) | A | 1.71–1.81 s | 1.28–1.37 s | – | – |
| 100k, the driver's `migrate()`, PostgreSQL 17.8 (own container) | A | 1.62–1.84 s | 1.09–1.23 s | – | – |
| 100k, the driver's transaction with `work_mem` at 6.4 MB (the sort spill of 1M rows at 64 MB), PostgreSQL 17.8 | A | – | 0.90–1.04 s (the spike's statements: 0.64–0.73 s) | – | – |
| 20k snapshots, the driver's `migrate()`, PostgreSQL 14.20 / 17.8 | A | 0.29–0.31 / 0.27–0.34 s | – | – | – |

- Of the driver's 1.6–1.8 s at 100k, 0.2–0.4 s is the inspection before the lock and 0.2–0.3 s the `VACUUM` after the commit. The dry run takes 0.2–0.26 s.
- Peak extra disk while the transaction ran (sampled from the database and spill directories, with the 1M-equivalent spill): 1.9–2.2 × the table's total size; the previous sorted reinsert peaked at 2.4 ×. The planner's warning asks for 3 ×.
- **The runbook figures are provisional:** about 0.5 minutes per million events under the lock on disk (the spike's 18.2 s per million, times the 1.25–1.6 ratio of the driver's transaction to the spike's statements at the same spill), plus about 5 seconds per million for the inspection and `VACUUM`; about 15 seconds per million snapshots on tmpfs; free disk 3 × the table; WAL about the table's size. A million rows were not measured with the statements that ship, and 10M rows not at all: the spike's 10M run filled the host disk, and the process rules cap local runs at 1M, and at 100k rows while the host has less than 15 GiB free (it had 9–11 GiB for every driver run). Re-measure at 1M on a host or CI runner with room before 4.0.
- The rewrite keeps the table's OID (grants, views and publication memberships survive); index OIDs and the relfilenode change. For snapshots, the `varchar → text` and `TIMESTAMP → TIMESTAMPTZ` conversion with `legacyTimeZone: 'UTC'` keeps the relfilenode (no rewrite), which `postgres.migration.spec.ts` asserts.
- Robustness (spike and `postgres.migration.spec.ts`): a session idle in a transaction on the table makes the lock time out (`55P03`) and the table is reported `blocked`; a second migrator of the same table in the same schema is refused by the advisory lock (its key names the schema); a backend killed mid-migration, or a crash injected after every step, rolls back to v1, and a rerun ends in the same dump as a clean run; a table that changes while the migration waits for its lock is reported `blocked`. After the migration, a 3.x insert fails with `42703` in milliseconds. With Docker's default 64 MB `/dev/shm`, a parallel `VACUUM` fails with `53100`, so the driver runs `VACUUM (ANALYZE, PARALLEL 0)` after the commit and reports a failure as a warning (a spec forces one).
- The dry run reads what would make the migration fail or lose something from the server: views and rules, policies, triggers (`WHEN` and `UPDATE OF` columns), publication row filters and column lists (PostgreSQL 15 and later) and generated columns on `event_date` or a converted column block the table; so do foreign keys of other tables, the catalog privileges, and table names that PostgreSQL truncated for 3.x. Columns a user added to a 3.x table are copied, not emptied. The `truncate` step refuses to run outside the transaction of the numbered copy, so the dry run's statements run one by one in autocommit leave the rows in place. `migrations/4.0.sql` is run with psql in CI (compared with `migrate()`, run twice, and without `legacy_time_zone`).

**CI** ([run 36609799561](https://github.com/ocoda/event-sourcing/actions/runs/36609799561) of the schema v2 PR after its review fixes, `ci-ok` green): on PostgreSQL 13, 14, 15, 16, 17 and 18, the whole driver suite passed (361 tests; the only skips are the capability gates `headers-unsupported-rejects` and `read-all-best-effort`), including `read-all-gap-safe`, the conformance suite without skips, the migration specs with crash injection and `migrations/4.0.sql` run with psql; the cross-version fixture passed on 13, 17 and 18 (29 checks each, comparing every snapshot envelope with what 3.0.2 read, and the 3.0.2 append after the migration was refused on every pool). Locally: PostgreSQL 14.20 and 17.8 green, the concurrency cases (`read-all-gap-safe`, `conflict-concurrent-appends`, `concurrent-any`, `append-atomic-partial-failure`) green 50 times in a row on both, and the cross-version fixture green.
- The review found that an append which lost a race classified its unique violation while it still held its connection, and asked the pool for a second one to read the primary key's name: with as many racing appends as connections, the pool deadlocked (no `connectionTimeoutMillis` by default). The append now classifies after it released its connection; specs run 2, 16 and 32 racing appends on pools of 1, 2 and 10 connections, each on a cold cache, under a timeout, and hang without the fix. A spec also appends under a `REPEATABLE READ` default (with a plain `BEGIN` instead of the explicit `READ COMMITTED`, the writers fail with `40001`).

### MariaDB

**Verdict: `globalOrder: 'gap-safe'` on InnoDB, with the hybrid reader below; `'best-effort'` on Galera (`wsrep_on`).** A plain keyset reader, as §3 was first written, is **not** gap-safe on MariaDB.

**InnoDB source citation** (MariaDB 10.11.15, commit `cb0d6dd`; the same order in 11.4.8 and 11.8.3):

- `trx_t::commit_in_memory` ([trx0trx.cc l.1375–1442](https://github.com/MariaDB/server/blob/cb0d6dd835023a7162ace471cd047161f205dd58/storage/innobase/trx/trx0trx.cc#L1375-L1442)) calls `trx_sys.deregister_rw(this)` (l.1420), which removes the transaction from `rw_trx_hash`, the set every new read view copies, **before** `release_locks()` (l.1442) releases the counter row's lock.
- That is not enough for a plain reader: `ReadViewBase::snapshot` copies the set with `rw_trx_hash.iterate` ([trx0sys.h l.1071–1086](https://github.com/MariaDB/server/blob/cb0d6dd835023a7162ace471cd047161f205dd58/storage/innobase/include/trx0sys.h#L1071-L1086)), a lock-free traversal ([lf_hash.cc l.517–537](https://github.com/MariaDB/server/blob/cb0d6dd835023a7162ace471cd047161f205dd58/mysys/lf_hash.cc#L517-L537)) that is not atomic against commits. The walk can pass T1 while it is active, then find the slot of T2 (which took the counter after T1 committed) already empty: the view shows T2's position without T1's lower one.
- **The hybrid reader closes it.** `readAll` hands out a batch only as far as its positions follow on from `fromPosition`. At the first gap it hands out the prefix; with an empty prefix it reads `H = last_position` of the catalog row `LOCK IN SHARE MODE` (autocommit), which returns only after the counter's holder passed `release_locks()`, so every transaction with a position ≤ `H` has left `rw_trx_hash`; it re-reads with `global_position <= H` and hands out everything (a gap below `H` is permanent). Positions have no holes (a rollback reverts the counter), so a contiguous batch is a committed prefix.

**S1, position stress** (spike, 10.11.15, 8 writers × 200 appends of 1–3 events, ~10% on two hot streams for conflicts):

- Writers: 15 runs, every event exactly once, contiguous positions `1..N`, counter = `MAX` after each run, conflicts roll the counter back, `insertId` = `LAST_INSERT_ID()` on every check. `innodb_snapshot_isolation=ON` with a consistent read before the counter `UPDATE` fails with 1020 under `REPEATABLE READ` and passes under `READ COMMITTED`.
- Plain readers without amplification: 0 misses in ~630k reader queries (5 base runs, 2 soak runs of 16 writers × 500).
- **Amplified** (16,277 prepared XA transactions, ~5 ms per read view): the plain reader missed 1–22 events per reader in 3 of 3 runs with correct writers; the HWM and hybrid readers had 0 misses in 6 of 6 runs.
- The broken reserve → sleep → commit writer was caught every time: plain readers 1,700–1,818 missing, HWM reader 1,687, hybrid readers under amplification 65 and 32.
- Throughput, one pool, 8 writers: 620–685 appends/s on tmpfs (p50 ≈ 10 ms, p99 16–18 ms); on disk 101/s with the binary log, 212/s without; 1 writer 339/s (tmpfs), 75/s (disk); 8 pools with 1 writer each 1,182/s in total (tmpfs), 438/s (disk). Always reading the HWM cost ~30% of writer throughput (476/s), hence the hybrid reader.

**G-maria measurements** (Docker on a macOS host, data on tmpfs, 128 MB buffer pool; the host had < 15 GiB free, so no run exceeded 100k rows):

- Append throughput with the driver, 8 writers × 200 appends and a tailing `readAll` per pool: 10.11.15: 665 appends/s on one pool (p50 11.7 ms, p99 17.9 ms), 1,421/s over 8 pools, 342/s for one writer; 11.8.9: 555/s, 1,559/s, 345/s. Every event read exactly once.
- Amplified `read-all-gap-safe` (driver spec `mariadb.read-all-gap-safe.spec.ts`, 12,000 prepared XA transactions, 5 rounds × 8 writers × 100 appends): 11.4.13, 3 runs: the plain keyset reader missed 6, 0 and 0 events; the store's `readAll` missed none and settled 1 torn batch under the high-water mark. 11.8.9, 1 run: 0 and 0.
- **Torn read views observed so far:** on 10.11 in the spike (3 of 3 amplified runs with 16,277 prepared transactions) and on 11.4 once (the run above). None on 11.8 (1 local run with 12,000, 3 CI rounds with 1,000), which shows how rare they are, not that 11.8 is free of them: its read view walk is the same (11.8.3 source). The claim for every version rests on the source citation, the hybrid reader, and the deterministic check of its settle path below.
- Migration of a synthetic 3.x table of 100,000 events (91.5 MB, 10 per stream, 5% written an hour off, 0.1% unrepairable): 10.11.15: dry run 2.1 s (the `occurred_on` counts 1.9 s), migration 2.5 s (copy 1.97 s, catch-up 0.17 s), 104,846 rows S-locked by the copy in 0.52 MB of lock memory, 56 MB of redo, 99 MB of page writes; 11.8.9: dry run 3.5 s, migration 2.7 s (copy 2.2 s). Positions `1..100000`, no stream out of version order, 99,900 `occurred_on` values restored from the event ids, the next append at 100,001.

**S2, migration timing** (spike, 1M events, 10.11.15 on tmpfs, 128 MB buffer pool): as first written in §6, 307.5 s (copy 295.8 s, 26.2 GB of page writes); with `unique_checks=0, foreign_key_checks=0` for the copy into the empty table, **74.9 s** (copy 68.2 s, catch-up 6.4 s, 0.39 GB of page writes, 397 MB of redo), same result. The copy S-locks every source row (1,032,688 rows, 3.4 MB of lock memory), so a 3.x insert during the copy waits and fails with 1205 while reads continue. Peak extra disk ≤ 0.93 × the v1 table plus a temporary table in `tmpdir`. Dry run: gapped streams 1.8 s, case variants 5.9 s, `occurred_on` counts 35–37 s. 10M rows were not run (tmpfs too small; a disk-backed attempt filled the host disk). The spike's copy numbered the events with one window; the shipped copy needs three (the rank, the D33 running maximum per stream, the numbering), and the operations review measured it on 11.8 (tmpfs, same synthetic table) at about twice the spike copy's time: 1.12–1.18 s against 0.56 s for 50,000 events, 2.38–2.54 s against 1.35 s for 100,000 (also with a 20 MB buffer pool). Its sorts took about 1.35 × the table's data and indexes in `tmpdir` (+44 MB at 50,000, +88 MB at 100,000), not 0.6 ×; a 40 MB `tmpdir` failed the copy with `1296 Got error 59 'Temp file write failure'`, and every rerun failed the same way. **Runbook figures:** ~3 min per million events for the migration (the spike's 75 s per million, doubled, with headroom; a 1M run of the shipped copy is still to be measured on a host with room), ~0.75 min per million for the dry run, free space 1.5 × the event table in the data directory and 1.5 × in `tmpdir`; a binary log in `MIXED` format logs the copy as one statement, so replicas rerun it (same `tmpdir`, lag of the copy's duration).

**CI** ([#571](https://github.com/ocoda/event-sourcing/pull/571)), green on MariaDB 10.11, 11.4 and 11.8:

- The conformance suite with no skips beyond the capability gates (`headers-unsupported-rejects`, `read-all-best-effort`), including `read-all-gap-safe`, `append-atomic-partial-failure` (a `SIGNAL` trigger), `occurred-on-milliseconds`, `latest-unique-concurrent`, `aggregate-cursor-paging` and `registered-on-milliseconds`.
- **The settle path, deterministically** (`mariadb.event-store.spec.ts` › readAll): an append held in flight after its counter update, with its position 3 uncommitted and position 4 committed, is the state a torn read view shows. `readAll` from 3 sees 4 without 3, reads the counter `LOCK IN SHARE MODE`, waits on the counter row (seen in `INNODB_TRX` as a lock wait), and delivers `[3, 4]` once the append commits. Without `LOCK IN SHARE MODE` it delivers `[4]`; the plain keyset reader (negative control) delivers `[4]` too.
- The amplified spec with 1,000 prepared XA transactions: on every version `readAll` read every event exactly once, but no torn view occurred (`readAll` settled 0 gaps, the plain keyset reader missed 0 events in 3 rounds), so in CI it shows exactness under load, not the settle path; 1,000 was the addendum's "a few hundred–thousand", fewer than the ~16,000 the spike needed.
- The migration specs with crash injection after every step, the planner's table-driven specs, `migrations/4.0.sql` run as a file (same result as `migrate()`, and it stops at a taken lock), and the cross-version fixture.

**Cross-version fixture** (3.0.2 writer in `America/New_York`, 200 events in 4 pools, 37 snapshots): every pool is refused before the migration; the dry run changes no table or checksum and reports, per pool, `from: 'v1'`, the duplicate event id, the gapped stream plus the lower-case twin that the binary collation splits off (`caseVariantStreams: 1`; *amended 2026-09-30:* now one stream under `account-Acc-1`, the id of its lowest version, with the twin's snapshot, and `canonicalizedStreams` lists both), and `occurredOnRepair` with `tzShifted` = every row and `kept: 0` (119, 56, 16 and 9 events); after `migrate()` positions are `1..N` in 3.x order with every stream in version order (D33, including the inverted and out-of-order streams), `occurredOn` equals what 3.0.2 appended, to the millisecond (3.x read it an hour off in the repeated hour of the end of daylight saving time), the next appends continue at `N + 1`, the gapped stream conflicts with its `actualVersion`, every snapshot stream has exactly one flag on its highest version, the legacy pool's `registered_on` values survive (the `ON UPDATE` attribute never fires), and a 3.0.2 append afterwards fails with 1136 in every pool.

**Amendments to §3 and §6 (MariaDB) from this evidence** (addendum M1–M8; §3 and §6 now describe them):

- `readAll` is the hybrid reader above, not a plain keyset.
- An append runs `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` before `START TRANSACTION` (`innodb_snapshot_isolation=ON`, the default from 11.6.2, fails a `REPEATABLE READ` transaction with 1020); a 1020 is `not-persisted`. `appendSnapshot` also runs in `READ COMMITTED`.
- The catch-up joins on `n.stream_id = CONVERT(o.stream_id USING utf8mb4) COLLATE utf8mb4_bin` (a plain `COLLATE` fails with 1253 on latin1 and utf8mb3 tables), and numbers by the D33 key, like the copy.
- The copy runs with `unique_checks = 0, foreign_key_checks = 0`, listed as steps of the dry run; `ER_LOCK_TABLE_FULL` at the copy suggests a bigger buffer pool or a `READ COMMITTED` copy by hand.
- The named lock is `CONCAT('ocoda:migrate:', SHA1(CONCAT(DATABASE(), '.', <t>)))` (10.11 rejects names over 192 characters).
- The `occurred_on` counts of the dry run compute the decoded event id time in a derived table, and are documented at ~0.75 min per million rows (35–37 s per million in S2, 1.9–4.0 s per 100,000 here).
- Registration (`ensureCollection`) reads `MAX(global_position)` without locks, then upserts the catalog row with `GREATEST`. The `INSERT … SELECT` of §3 locks the table's last row under `REPEATABLE READ` and deadlocked with every concurrent append (0 of ~960 registrations succeeded while 6 writers appended), so an instance could not start while others wrote. The `INSERT … SELECT` stays in the `ddl: 'none'` remedy and the offline migration.
- `appendSnapshot` runs again, up to 10 times, when InnoDB picks it as a deadlock victim: the duplicate checks of `ux_latest` lock neighbouring keys, so appends to different streams of one aggregate deadlock under load (921 failures in 6,400 racing appends without the retry, 0 with it; once in CI on 11.8).
- Snapshots: the conversion (`ALTER … ALGORITHM=COPY, LOCK=SHARED`) runs first, so the flag repairs compare stream ids in binary and the `ON UPDATE` attribute is gone before any `UPDATE`; then the superseded flags are cleared, the highest versions flagged, and `ux_latest` added (`ALGORITHM=INPLACE, LOCK=SHARED`).
- The stores' pool sessions run in `READ COMMITTED` (appended to `initSql`): a server or `initSql` default of `READ UNCOMMITTED` would let `readAll` hand out an append that then rolls back, and whose positions another append reuses.
- A deadlock (1213) in answer to `COMMIT`, which is how Galera reports a failed certification, rolled the transaction back: `not-persisted`. Any other failure of the `COMMIT` stays `unknown` (D3).
- `readAll` needs both of its reads on the server the appends run on; a read/write-splitting proxy that sends the batch to a lagging replica would make a lag gap look permanent. Documented; not detectable by the store.
- The D33 key partitions by the 3.x table's stream id, in its (usually case-insensitive) collation, in the copy and the catch-up: stream ids that differ in case only are one 3.x stream there, and each of the two schema v2 streams keeps its version order (the key never decreases along the 3.x stream's versions); ties break by version. *Amended 2026-09-30:* the same window gives the 3.x stream one id in schema v2, the id of its lowest version ([amendment](#amendment-minimal-manual-mariadb-operations)).
- The `occurred_on` repair decodes an id whose first 10 characters are Crockford base32 (any case) and whose 26 characters are letters or digits, as 3.x accepted them (`ULID_TIME_PATTERN`), not only canonical ULIDs: only the time part is decoded, so ids like `…ILOU` are repaired (the cross-version fixture's non-canonical ids, `kept: 0`). `nonCrockfordEventIds` counts the non-canonical ones.
- The migration's session pins `tx_isolation = 'REPEATABLE-READ'` (the copy's row locks are the 3.x fence, and a `READ COMMITTED` `INSERT … SELECT` is refused with `binlog_format=STATEMENT`); on Galera it also sets `wsrep_trx_fragment_unit = 'bytes', wsrep_trx_fragment_size = 64 MiB`, so the copy replicates in fragments instead of one write set that `wsrep_max_ws_size` (≤ 2 GiB) refuses, and the report warns to run against one node (`GET_LOCK` is per node).
- The acquire-lock step is `SELECT IF(GET_LOCK(<name>, 0) = 1, 1, (SELECT 1 UNION SELECT 2))`: a taken lock raises 1242, so `mariadb < migrations/4.0.sql` stops there (a `SELECT GET_LOCK` returning 0 didn't; `DO IF(…)` doesn't raise at all). The executor reads the 1242 as `blocked`.
- `migrate()` connects with `socketTimeout: 0`: an application's socket timeout dropped the connection mid-copy while the server finished the step, and the rerun was `blocked` by the orphaned session's lock. After a lost connection the error names the `IS_USED_LOCK()` to wait on.
- The dry run does not check privileges (§6 lists "missing privileges" as blocking): MariaDB grants through roles, `PUBLIC` and database patterns make an `information_schema` check prone to refusing users that have them. A step that lacks one fails with the privileges it needs in its error, and the rerun continues. *Decided 2026-09-30:* the dry run still doesn't check them (it writes nothing, and `PREPARE` checks `CREATE` and `UPDATE` but not `ALTER`, `DROP` or `RENAME`), and the migration checks the swap's privileges before the copy, so a missing privilege never costs a copy ([amendment](#amendment-minimal-manual-mariadb-operations)).

### MongoDB

From the MongoDB schema v2 PR. The spikes ran on MongoDB 8.2.4 in Docker (a single-node replica set `rs0`, and the standalone test server), driver `mongodb` 7.7.0, Node.js 24, on a laptop whose load average was 13 to 20 from other runs: the timings are on the slow side.

**S1, position stress** (the §4 transaction: counter first, `readConcern: 'snapshot'`, `w: 'majority'`, own 30 s retry loop with a 100 ms backoff cap; a tailing keyset reader with majority read concern; `ExpectedVersion.Any` writers on 32 shared streams):

| Run | Appends/s per pool | WriteConflicts per append | Max attempts | p99 / max latency | Holes, missed, duplicates, out of order |
| --- | --- | --- | --- | --- | --- |
| Replica set, 8 writers × 200 appends, 5 runs | 292–329 | 1.81–1.84 | 14–19 | 279–339 / 592–753 ms | 0 |
| Soak, 8 × 2000 appends, batch 10 | 229 | 2.12 | 23 | 399 ms / 1.67 s | 0 |
| 1 writer × 1600 | 266 | 0 | 1 | 7.5 / 15.9 ms | 0 |
| 16 writers × 100 | 195 | 3.35 | 26 | 869 ms / 1.96 s | 0 |
| 4 pools, 8 writers each | 128 each, ≈ 512 together | 2.32–2.52 | 19–29 | ≈ 600 ms / 1.58 s | 0 |
| Broken: reserve, sleep ≤ 5 ms, commit (3 runs) | – | – | – | – | 620–773 missed: **detected** |
| Standalone, the §4 compensation path | 1298 | – | – | – | 516 holes, 69 missed: **not gap-safe** |

- Every replica-set run delivered each event exactly once, in strictly increasing positions, without holes: 20 pool-runs, about 52,000 appends. The catalog's `lastPosition` equalled the highest position and the event count every time.
- `UnknownTransactionCommitResult` never occurred, and no append came near the 30 s budget.
- On a standalone server a transaction fails with the driver error "does not support retryable writes", not a usable server code, so the store detects the topology with `hello` before it chooses a path.

**S2, migration timing** (the spike's numbering, with one sort; the shipped D33 pipeline adds two sorts, see "Sort spill of the shipped pipeline" below. Synthetic 3.x collections, ≈ 446 B per event, ten events per stream, the two 3.x indexes; replica set):

| Numbering | 1M events: numbering / to the commit point / total | Min per million | Oplog per million | Sort spill |
| --- | --- | --- | --- | --- |
| Client-side cursor, 1,000-update bulk writes (§6 as first planned) | 53.9 s / 60.4 s / 77.5 s | 1.29 | 567 MB | 0 |
| Server-side, `$concat(eventDate, '#', _id)` key | 39.4 s / 42.7 s / 61.5 s | 1.03 | 425 MB | 40 MB |
| Server-side, `_id` key | 54.4 s / 59.8 s / 83.8 s | 1.40 | 431 MB | 0 |

- All three numbered 1M events identically (sha256 over `(_id, position)`).
- At 10M the client-side numbering took 17 minutes (about 14.5 without a stray concurrent query), over the 10-minute threshold of §6, so the PR numbers on the server. The server-side 10M run wasn't done: the host disk filled up.
- `$documentNumber` returns a 32-bit integer, which the fence's validator rejects (121): the pipeline converts it with `$toLong`. It accepts a single sort key.
- The dry run's `$group` over the streams took 353 s at 10M; the PR scans the `{ streamId, version }` index once instead, with the counts per stream computed in the client.
- Only `collMod`, `createIndex` and `dropIndex` took exclusive collection locks, for milliseconds; a probe reading every 50 ms never blocked. The collection's storage grew about 2.4×.

**The PR's own measurements** (at most 100,000 rows locally after the disk incident; MongoDB 8.2.4 single-node replica set, load average ≈ 19): 100,000 events migrate in 5.8–6.2 s, 0.98–1.04 minutes per million: the numbering takes 3.25–3.43 s with the `_id` key and 3.60 s with the `$concat` key, the unique index 0.20–0.23 s, the `eventDate` clean-up 1.45–1.75 s, and the dry run 0.39–0.41 s. The oplog grew by 47 MB per 100,000 events. The committed `migrations/4.0.mongosh.js` and `migrate()` leave identical collections, validators, indexes and catalog documents on the same 3.x seeds, with canonical and with non-canonical ids (`mongodb.migration-script.run.spec.ts`, which runs where `mongosh` is installed).

**Sort spill of the shipped pipeline** (from the PR's review). The S2 figures are those of the single-sort spike pipeline. The D33 pipeline adds two sorts over every event, by `{ streamId, version }` and by the order key, whatever the ranking key; `explain` estimated them at 70–100 MB per 100,000 events, so at the default 100 MB sort limit they spill from roughly 90,000 to 130,000 events on, and the 100,000-event timing above is of a run that didn't spill. With the sort limit lowered to 5–10 MB (standing in for a million events and more), they spilled about 100–150 MB per million events with the `_id` key and 165–250 MB with the `$concat` key. MongoDB 8.2 refuses to spill with less than 500 MB free in the `dbPath`, and 7.1 and later refuse an index build below 500 MB. Minutes per million at a million events and more remain to be measured with this pipeline.

**CI** ([run 36601997169](https://github.com/ocoda/event-sourcing/actions/runs/36601997169), PR #572, and after the review fixes [run 36608855195](https://github.com/ocoda/event-sourcing/actions/runs/36608855195)): on MongoDB 6, 7 and 8, each as a standalone server and a replica set in one job, the driver suite passed (after the review: 505 passed, 28 skipped by capability, by topology or with a reason, 6 of them the mongosh run of the script, since the runner has no mongosh; coverage 97.1 % statements, 95.3 % branches). `read-all-gap-safe` passed on the replica set of every version (first run 6: 1.8 s, 7: 0.7 s, 8: 1.0 s; after the review 6: 2.0 s, 7: 1.9 s, 8: 1.7 s) and is skipped by capability on the standalone servers, where `read-all-best-effort` passed. A spec now also asserts the majority read concern of every `readAll` batch and the transaction options, which a single-node replica set can't tell apart otherwise. The migration specs, crash injection after every step included, passed on both topologies of every version. The cross-version test (MongoDB 8, both topologies) migrated the 3.0.2 corpus, read it back as 3.0.2 did with positions in 3.x's order and every stream in version order, and a 3.0.2 append afterwards was refused on every pool.

**Decision.** Replica sets claim `'gap-safe'`; standalone servers and sharded clusters stay `'best-effort'`. The migration numbers on the server by default, with the `_id` key when every id of the collection is a canonical ULID and the `$concat` key otherwise (D35).

## Alternatives considered

- **A counter table per pool** instead of one catalog: more objects to create, grant and clean up, and no single source for `listCollections` (D17).
- **A sequence, an identity column or `AUTO_INCREMENT`** as the position: values are handed out in allocation order but commit out of order, so a tailing reader skips late commits (ADR 0001). **A PostgreSQL identity column read behind a `pg_snapshot_xmin` fence, or an `xid8` column:** workable, but more moving parts than the counter row. Deferred; an `xid8` column can be added later without a rewrite (D19).
- **PostgreSQL shadow copy and swap:** loses OID-bound grants, publications and dependent views. In-place keeps them.
- **MariaDB in-place `ALTER` and `UPDATE`:** the backfill `UPDATE` fires the legacy `ON UPDATE` attribute, and `TIMESTAMP → DATETIME(3)` rebuilds the table anyway. Copy and swap avoids the hazard and leaves a backup.
- **MongoDB `$setWindowFields` sorted on `eventDate` and `_id`:** invalid, because `$documentNumber` needs exactly one sort key. The server-side numbering ranks by `_id`, or by a concatenated key (§6).
- **`withTransaction` for MongoDB appends:** retries for up to 120 s. A bounded 30 s loop fails faster and reports the last error.
- **An online, multi-phase migration:** many more states to test. 4.0 guarantees an offline migration only; an online "prepare" phase is additive later (MariaDB `INVISIBLE` columns and PostgreSQL nullable columns make it possible) (D30).
- **Keeping MariaDB's case-insensitive collation:** see [owner decision 1](#owner-decisions).

## Consequences

**Positive**

- Every built-in store has a per-pool global order. It is gap-safe on the SQL stores and on MongoDB replica sets where the [evidence](#evidence) holds (MariaDB: InnoDB, not Galera), so 4.x subscriptions, projections and the outbox can checkpoint it, and each claim is backed by a conformance case.
- One catalog lists collections, registers schema versions and counts positions, and `ensureCollection` heals counter drift.
- 3.x writers that are still running after the migration fail loudly instead of writing events without positions. (A 3.x MariaDB snapshot write still succeeds; the runbook says to stop every 3.x instance first.)
- MariaDB `occurred_on` values that 3.x truncated to the second or shifted by a time zone are restored to the millisecond where the ULID proves the value.
- Appends are no longer limited to about 6,500 events on PostgreSQL.

**Negative**

- Appends within a pool serialize on its counter row. Pools are the unit of write scale, and the docs say so with the S1 numbers.
- The migration is offline, rewrites every event row (PostgreSQL, MongoDB) or copies every event table (MariaDB), and blocks the writes to each table while it runs (PostgreSQL: `ACCESS EXCLUSIVE`; MariaDB: the copy's shared row locks and `LOCK=SHARED`; MongoDB: the validator fence).
- MariaDB stream ids become case-sensitive (owner decision 1). The migration keeps a 3.x stream whose ids differ in case only one stream, under the id of its lowest version, and the application must use that id afterwards.
- MongoDB standalone servers stay `'best-effort'` and burn positions on failed appends.
- A bigint in a payload fails on the SQL stores.

## Test plan

| Decision | Proof | Kind |
| --- | --- | --- |
| §1 positions, gap safety | `read-all-order`, `read-all-resume`, `read-all-gap-safe` (gated on `'gap-safe'`), `read-all-best-effort`; negative controls prove the detectors fire | conformance |
| §1 unknown pools | `unknown-pool-append`, `unknown-pool-read` | conformance |
| §1 detection, `ensureCollection` | Every state × `ddl` row of the table, including a crashed creation and a counter healed after a drop | driver unit |
| §1 bigint | Positions read as text; `bigIntAsNumber: true` (MariaDB) and `useBigInt64: true` (MongoDB) specs | driver unit |
| §2–§4 outcomes | Every row of the outcome table in ADR 0001 amendment D3, including counter drift and a lost connection | driver unit, resilience |
| §3 dates | `occurred-on-milliseconds`, `registered-on-milliseconds` on MariaDB | conformance |
| §2–§4 snapshots | `latest-unique-concurrent`, `aggregate-cursor-paging` (binary, exclusive) | conformance |
| §6 migration | `<db>.migration.spec.ts`: v1 seeds from the verbatim 3.0.0 and 3.0.2 DDL; the dry run writes nothing (schema dump and row checksum unchanged); positions `1..N` in 3.x order; `occurred_on` preserved or repaired; a second run reports `skip`; a 3.x-shaped insert is rejected; a 4.0 append continues at `N + 1`; PostgreSQL `relfilenode` unchanged; crash injection after every step yields the same final dump as a clean run | driver unit |
| §6 cross-version | 3.0.2 writes (non-UTC writer, legacy DDL and index variants), 4.0 migrates, reads, appends; a 3.0.2 append afterwards fails | cross-version |
