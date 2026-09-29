# ADR 0002: Schema v2 (global position, catalog, migration)

- **Status:** Proposed
- **Date:** 2026-09-29
- **Scope:** plan milestone M7: the 4.0 event and snapshot schemas of the PostgreSQL, MariaDB and MongoDB stores, the global position technique behind [ADR 0001](./0001-v4-core-api.md) §9, and the one-time `migrate()` from 3.x
- **Depends on:** ADR 0001 §1, §8 and §9, and its [store contract amendments](./0001-v4-core-api.md#amendments-store-contract) (D1–D32)
- **Baseline:** `origin/master` `0c345dd` (`4.0.0-next.1`); the 3.x schemas that 3.0.0 to 3.0.2 create
- **Amendments:** none yet. The [Evidence](#evidence) section is filled in by the driver PRs; the [owner decisions](#owner-decisions) have defaults applied.

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
  - `v1`: the collection exists, with no catalog document and no validator.
  - `v1-partial`: a validator, or documents with `globalPosition`, without a catalog document.

**`ensureCollection(pool)` for events.** A new `ddl` option chooses whether the store may create schema objects.

| State | `ddl: 'auto'` (default) | `ddl: 'none'` (no CREATE, ALTER or DROP; DML allowed) |
| --- | --- | --- |
| catalog missing | create it | `EventStoreSchemaException { found: 'missing', remedy: <DDL> }` |
| `absent` | create the v2 table, indexes and validator, then register | `EventStoreSchemaException { found: 'missing', remedy: <DDL> }` |
| `v2` | register, or heal the counter (`GREATEST`) | same |
| `v2`, unregistered and empty (creation crashed; on MariaDB, no `<t>__es_v1` backup) | finish the creation, register | register |
| `v1` / `v1-partial` | `EventStoreSchemaException { found, remedy: 'run XEventStore.migrate(config, { dryRun: true }), then migrate()' }`. **Never migrates.** | same |

The core module's `onModuleInit` calls `ensureCollection()` for the default pool, so a v1 default pool fails bootstrap with that message. Tenant pools fail on their first `ensureCollection`.

**`ensureCollection(pool)` for snapshots**

- `absent`: create the v2 table and register it (kind `'snapshots'`).
- `v1`: `logger.warn` once, register it with `schema_version 1`, and keep working. The v2 SQL lists its columns, which have the same names in v1.
- `ddl: 'none'` and `absent`: `SnapshotStoreCollectionCreationException`, with the DDL in the message.

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
  ON CONFLICT (name) DO UPDATE SET schema_version = 2,
    last_position = GREATEST(event_sourcing_collections.last_position, EXCLUDED.last_position);
```

**`persistEvents`.** It encodes first (`JSON.stringify` of each payload and headers, `toISOString()` of each `occurredOn`) **before** acquiring a client, then runs on a dedicated client:

```sql
BEGIN ISOLATION LEVEL READ COMMITTED;   -- explicit: under REPEATABLE READ or SERIALIZABLE the waiter gets 40001
UPDATE event_sourcing_collections SET last_position = last_position + $2
  WHERE name = $1 AND kind = 'events' RETURNING last_position::text;   -- 0 rows: ROLLBACK, not-persisted
INSERT INTO "<t>" (stream_id, version, event, payload, event_id, aggregate_id, occurred_on,
                   correlation_id, causation_id, global_position, headers, event_version)
SELECT * FROM unnest($1::text[], $2::int[], $3::text[], $4::jsonb[], $5::text[], $6::text[], $7::timestamptz[],
                     $8::text[], $9::text[], $10::bigint[], $11::jsonb[], $12::int[]);
COMMIT;
```

- The positions are `last - n + 1n … last`.
- `unnest` keeps the insert at 12 parameters, which removes the 3.x ceiling of 65,535 / 10 parameters (about 6,500 events per append).
- The primary key constraint name is read from `pg_constraint` (`contype = 'p'`) on the first `23505` and cached per table, to tell a conflict from counter drift.
- A client that saw a connection-level error is destroyed, not released.

**Reads**

- `getStreamVersion`: `SELECT COALESCE(MAX(version), 0) AS v FROM "<t>" WHERE stream_id = $1`.
- `getEnvelope(s)`: keep `pg-cursor` for stream reads, with the new columns.
- `readAll`: a keyset over `pool.query`: `SELECT global_position::text AS global_position, event, payload, event_id, aggregate_id, version, occurred_on, correlation_id, causation_id, headers, event_version FROM "<t>" WHERE global_position >= $1 ORDER BY global_position LIMIT $2`.
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

**Catalog**

```sql
CREATE TABLE IF NOT EXISTS event_sourcing_collections (
  name VARCHAR(64) NOT NULL PRIMARY KEY, kind ENUM('events', 'snapshots') NOT NULL,
  schema_version SMALLINT NOT NULL, last_position BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
```

**Events** (the collation is [owner decision 1](#owner-decisions))

```sql
CREATE TABLE IF NOT EXISTS `<t>` (
  stream_id VARCHAR(255) NOT NULL, version INT NOT NULL, event VARCHAR(255) NOT NULL, payload JSON NOT NULL,
  event_id VARCHAR(40) NOT NULL, aggregate_id VARCHAR(255) NOT NULL, occurred_on DATETIME(3) NOT NULL,
  correlation_id VARCHAR(255) NULL, causation_id VARCHAR(255) NULL,
  global_position BIGINT NOT NULL, headers JSON NULL, event_version INT NULL,
  PRIMARY KEY (stream_id, version), UNIQUE KEY ux_global_position (global_position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
INSERT INTO event_sourcing_collections (name, kind, schema_version, last_position)
  SELECT ?, 'events', 2, COALESCE(MAX(global_position), 0) FROM `<t>`
  ON DUPLICATE KEY UPDATE schema_version = 2, last_position = GREATEST(last_position, VALUES(last_position));
```

**Dates.** `DATETIME(3)` holds UTC wall time, independent of the connector's `timezone` and the session's `time_zone`:

- Write `d.toISOString().slice(0, 23).replace('T', ' ')`.
- Read `CAST(occurred_on AS CHAR)` and parse it with `new Date(s.replace(' ', 'T') + 'Z')`.

**`persistEvents`.** It encodes before `getConnection()`, then runs on a dedicated connection:

```sql
START TRANSACTION;
UPDATE event_sourcing_collections SET last_position = LAST_INSERT_ID(last_position + ?) WHERE name = ? AND kind = 'events';
-- affectedRows 0: ROLLBACK, not-persisted. last = BigInt(String(result.insertId)),
-- or SELECT CAST(LAST_INSERT_ID() AS CHAR) as a fallback
INSERT INTO `<t>` (stream_id, version, event, payload, event_id, aggregate_id, occurred_on,
                   correlation_id, causation_id, global_position, headers, event_version) VALUES (?, …), …;
COMMIT;
```

- The version pre-check stays outside the transaction, in the template.
- An InnoDB `UPDATE` is a locking read of the latest committed row, even under `REPEATABLE READ`, so the default isolation is correct.
- `1062`: parse `/for key '(?:[^.']*\.)?([^']+)'/` from `sqlMessage`. `PRIMARY` is a conflict; `ux_global_position` is counter drift.
- After `1205`, issue an explicit `ROLLBACK` (`innodb_rollback_on_timeout` is off by default).
- `readAll`: a keyset with `CAST(global_position AS CHAR)`, one autocommit statement per batch, so each batch gets a fresh read view.

**`connect()`**

- `createPool`, then probe with `SELECT @@wsrep_on AS wsrep`; an unknown variable counts as `OFF`. The probe also makes a bad connection fail at bootstrap.
- `wsrep = ON` (Galera) gives `globalOrder: 'best-effort'`, because row locks aren't cluster-wide.

**Capabilities:** `{ atomicAppend: true, headers: true, globalOrder: 'gap-safe' }` on InnoDB, **only if** the [evidence](#evidence) (the stress test, the source citation and `read-all-gap-safe` on 10.11, 11.4 and 11.8) holds. Otherwise `'best-effort'`.

**Snapshots**

```sql
CREATE TABLE IF NOT EXISTS `<t>` (
  stream_id VARCHAR(255) NOT NULL, version INT NOT NULL, payload JSON NOT NULL, snapshot_id VARCHAR(40) NOT NULL,
  aggregate_id VARCHAR(255) NOT NULL, registered_on DATETIME(3) NOT NULL, aggregate_name VARCHAR(255) NOT NULL,
  latest VARCHAR(270) NULL,
  PRIMARY KEY (stream_id, version), UNIQUE KEY ux_latest (aggregate_name, latest)   -- NULLs are distinct
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
```

- `appendSnapshot`: `START TRANSACTION`, then `SELECT … WHERE latest = ? FOR UPDATE` (moved **inside** the transaction), then unflag with `registered_on = registered_on`, then an `INSERT` that lists its columns, then `COMMIT`.
- A `1062` on `PRIMARY` or `ux_latest` is a snapshot conflict.

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

- Documents: `{ _id: eventId, streamId, version, event, payload, aggregateId, occurredOn: Date, correlationId?, causationId?, globalPosition: Long, headers?, eventVersion? }`. Inserts pass `ignoreUndefined: true`; reads map `null` to `undefined`.
- Indexes: `{ streamId: 1, version: 1 }` unique, and `{ globalPosition: 1 }` unique.
- Validator (`validationLevel: 'strict'`, `validationAction: 'error'`): `{ $jsonSchema: { bsonType: 'object', required: ['globalPosition', 'streamId', 'version'], properties: { globalPosition: { bsonType: 'long' } } } }`.
- Creation: `createCollection(name, { validator, … })`, treating `NamespaceExists` (48) as success, then `createIndexes` (idempotent), then the catalog registration `updateOne({ _id: name }, { $setOnInsert: { kind: 'events' }, $set: { schemaVersion: 2 }, $max: { lastPosition: Long(maxPosition) } }, { upsert: true })`.
- The catalog lookup replaces `knownCollections` and `assertCollectionExists`.

**`persistEvents` on a replica set or `mongos`.** The store runs its own bounded loop instead of `withTransaction`, which retries for 120 s. The total budget is 30 s, with a backoff of `random(0, min(100, 2 ** attempt))` ms. Each attempt:

```ts
session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
const counter = await catalog.findOneAndUpdate(
	{ _id: collection, kind: 'events' },
	{ $inc: { lastPosition: Long.fromNumber(n) } },
	{ session, returnDocument: 'after', projection: { lastPosition: 1 } },
); // null: abortTransaction, throw not-persisted (cause EventCollectionNotFoundException)
await events.insertMany(docs, { session, ordered: true, ignoreUndefined: true });
await session.commitTransaction(); // UnknownTransactionCommitResult: retry the commit up to 3 times, then throw 'unknown'
```

- A `TransientTransactionError` aborts and retries the attempt.
- `11000` is classified per ADR 0001 amendment D3.
- When the budget runs out, the append fails with `not-persisted` and the last error as its cause.

**`persistEvents` on a standalone server**

1. `findOneAndUpdate` with `$inc`, without a session, reserves the block.
2. An ordered `insertMany`.
3. On any failure, the existing `discardInsertedEvents` compensation runs (by `insertedCount`), and the outcome is classified per D3. The reserved positions are burned.

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
		caseVariantStreams?: number; // MariaDB: streams split by the case-insensitive → binary collation change
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

#### Common rules

- `migrate()` runs inspect, then a pure `plan(inspection, options)`, then execute. Each step is skipped when its postcondition already holds, so a second run reports `skip`.
- A dry run returns the exact resolved statements. DBAs who use `ddl: 'none'` run those.
- Numbering is `ORDER BY event_date, event_id, stream_id, version` (MongoDB: `eventDate, _id`): 3.x's order with a deterministic tiebreak.
- **Offline.** 3.x writers must be stopped. After the migration, a 3.x write fails loudly:
  - PostgreSQL: `event_date` is gone (`23502` / `42703`).
  - MariaDB: the column count doesn't match (`1136`).
  - MongoDB: the validator rejects it (`121`).
- `blocking` issues abort before any write:
  - PostgreSQL views or rules that depend on `event_date`
  - MariaDB triggers or foreign keys on the table
  - sharded MongoDB collections
  - missing privileges
  - non-string MongoDB `_id`s
  - MongoDB servers older than 5.0

**Gapped streams** (PostgreSQL and MariaDB; MongoDB does the same with `$group`, `$match { $expr }` and `$facet`, with `allowDiskUse`):

```sql
SELECT stream_id, COUNT(*) AS events, MIN(version) AS min_version, MAX(version) AS max_version
FROM <t> GROUP BY stream_id HAVING MIN(version) <> 1 OR MAX(version) <> COUNT(*) ORDER BY stream_id LIMIT 1000;
-- plus SELECT COUNT(*) FROM (… the same GROUP BY and HAVING …) AS g for the total
```

#### PostgreSQL events: in place, one transaction per table

This keeps the table's OID, so grants, publications and views survive. A dedicated client takes the session lock `pg_try_advisory_lock(hashtext('ocoda:migrate'), hashtext(<t>))`; if it isn't acquired, the collection is `blocked: 'another migration is running'`. The catalog table is created first, in its own transaction.

```sql
BEGIN;
SET LOCAL lock_timeout = '<lockTimeoutMs>ms'; SET LOCAL statement_timeout = 0;
LOCK TABLE "<t>" IN ACCESS EXCLUSIVE MODE;          -- lock timeout: blocked, "sessions still use the table (3.x running?)"
-- re-inspect under the lock; abort if the state changed
ALTER TABLE "<t>" ADD COLUMN IF NOT EXISTS global_position BIGINT, ADD COLUMN IF NOT EXISTS headers JSONB,
  ADD COLUMN IF NOT EXISTS event_version INTEGER,
  ALTER COLUMN stream_id TYPE TEXT, ALTER COLUMN event TYPE TEXT, ALTER COLUMN event_id TYPE TEXT,
  ALTER COLUMN aggregate_id TYPE TEXT, ALTER COLUMN correlation_id TYPE TEXT, ALTER COLUMN causation_id TYPE TEXT;
UPDATE "<t>" e SET global_position = n.rn
  FROM (SELECT stream_id, version, row_number() OVER (ORDER BY event_date, event_id, stream_id, version) AS rn FROM "<t>") n
  WHERE e.stream_id = n.stream_id AND e.version = n.version AND e.global_position IS DISTINCT FROM n.rn;
CREATE UNIQUE INDEX IF NOT EXISTS "<deriveIndexName(t, 'global_position')>" ON "<t>" (global_position);
ALTER TABLE "<t>" ALTER COLUMN global_position SET NOT NULL, DROP COLUMN event_date;   -- drops every event_date index
INSERT INTO event_sourcing_collections … VALUES ('<t>', 'events', 2, (SELECT COALESCE(MAX(global_position), 0) FROM "<t>"))
  ON CONFLICT (name) DO UPDATE SET schema_version = 2,
    last_position = GREATEST(event_sourcing_collections.last_position, EXCLUDED.last_position);
COMMIT;
-- then, outside the transaction: VACUUM (ANALYZE) "<t>"
```

The dry run lists `dependents` from `pg_depend` and `pg_publication_tables`, and the indexes that will be dropped. The runbook warns that the backfill `UPDATE` is replicated to CDC consumers and publications.

#### PostgreSQL snapshots (own transaction, `ACCESS EXCLUSIVE`)

1. Drop every non-unique btree on `(aggregate_name, latest)`, found by its columns.
2. De-duplicate the flags: `UPDATE s SET latest = NULL WHERE latest IS NOT NULL AND EXISTS (SELECT 1 FROM s n WHERE n.latest = s.latest AND n.version > s.version)`.
3. Re-flag streams without a flag: `UPDATE s SET latest = 'latest#' || s.stream_id FROM (SELECT stream_id, MAX(version) v FROM s GROUP BY stream_id HAVING COUNT(latest) = 0) m WHERE s.stream_id = m.stream_id AND s.version = m.v`.
4. `ALTER COLUMN … TYPE TEXT` for the text columns, `ALTER COLUMN latest TYPE TEXT COLLATE "C"`, and `ALTER COLUMN registered_on TYPE TIMESTAMPTZ USING registered_on AT TIME ZONE '<validated tz>'`. The time zone is an escaped literal, because a utility statement takes no bind parameters. When it is UTC, the step runs `SET LOCAL TimeZone = 'UTC'` and no `USING`, which skips the rewrite on PostgreSQL 12 and later.
5. Create the unique partial latest index.
6. Register the table in the catalog (`snapshots`, 2).

#### MariaDB events: copy and swap, per table

The copy never `UPDATE`s a 3.x row, so the `ON UPDATE` hazard can't fire. The `TIMESTAMP → DATETIME(3)` change needs a copy anyway, and the swap leaves a backup.

```sql
SET SESSION time_zone = '+00:00'; SET SESSION lock_wait_timeout = <s>; SET SESSION max_statement_time = 0;
SELECT GET_LOCK('ocoda:migrate:<db>.<t>', 0);          -- 0: blocked
DROP TABLE IF EXISTS `<t>__es_v2`;                      -- leftover of a crashed run (names hashed when > 64 characters)
CREATE TABLE `<t>__es_v2` ( …the v2 DDL… );
INSERT INTO `<t>__es_v2` (stream_id, version, event, payload, event_id, aggregate_id, occurred_on,
                          correlation_id, causation_id, global_position)
SELECT stream_id, version, event, payload, event_id, aggregate_id,
       <occurredOnExpr>,                                -- see below; `occurred_on` when repairOccurredOn is false
       correlation_id, causation_id,
       ROW_NUMBER() OVER (ORDER BY event_date, event_id, stream_id, version)   -- source collation = 3.x order
FROM `<t>`;
RENAME TABLE `<t>` TO `<t>__es_v1`, `<t>__es_v2` TO `<t>`;   -- atomic; 3.x inserts now fail with 1136
-- catch up rows 3.x wrote between the copy's snapshot and the RENAME (normally none; reported as a warning):
INSERT INTO `<t>` (…) SELECT …, @base + ROW_NUMBER() OVER (ORDER BY o.event_date, o.event_id, o.stream_id, o.version)
  FROM `<t>__es_v1` o LEFT JOIN `<t>` n ON n.stream_id = o.stream_id COLLATE utf8mb4_bin AND n.version = o.version
  WHERE n.stream_id IS NULL;                            -- @base = COALESCE(MAX(global_position), 0) of `<t>`
INSERT INTO event_sourcing_collections … ON DUPLICATE KEY UPDATE schema_version = 2, last_position = GREATEST(…);
SELECT RELEASE_LOCK('ocoda:migrate:<db>.<t>');
-- keepBackup false: DROP TABLE `<t>__es_v1`; otherwise the report prints the DROP statement
```

- **Crash recovery.** Before the `RENAME`, the state is still `v1`, and a rerun drops the leftover copy. After the `RENAME`, the state is `v1-partial` (the backup exists and there is no catalog row), and a rerun does the catch-up and registers the table.
- **`occurredOnExpr`** repairs 3.x's `TIMESTAMP(0)` truncation and a Node.js time zone that differs from the server's. Let `u` be the ULID millisecond time of `event_id` (its first 10 Crockford base32 characters, decoded by a generated 10-term `LOCATE(…) * POW(32, k)` sum, with a JavaScript reference implementation for the tests), and `d = UNIX_TIMESTAMP(occurred_on) - FLOOR(u / 1000)`.
  - If `event_id` matches `^[0-9A-HJKMNP-TV-Z]{26}$` (case-insensitive), `ABS(d) <= 50400` and `MOD(d, 900) = 0`, use `u`, to the millisecond.
  - Otherwise keep the column's value.
  - The dry run reports the four counts (`exact`, `precisionOnly`, `tzShifted`, `kept`).
- **Case-variant streams.** The dry run counts the streams that the change to a binary collation splits (`GROUP BY BINARY stream_id` against `GROUP BY stream_id`) and reports them as gapped.

#### MariaDB snapshots (in place, session `time_zone` `'+00:00'`)

1. De-duplicate the flags with `SET s.latest = NULL, s.registered_on = s.registered_on`, through a derived-table `JOIN` (which avoids error 1093).
2. Re-flag streams without a flag, the same way.
3. `ALTER TABLE s CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin, MODIFY stream_id VARCHAR(255) NOT NULL, MODIFY latest VARCHAR(270) NULL, MODIFY registered_on DATETIME(3) NOT NULL, DROP INDEX <each index on (aggregate_name, latest)>, ADD UNIQUE KEY ux_latest (aggregate_name, latest), ALGORITHM=COPY, LOCK=SHARED`. `MODIFY` removes the `ON UPDATE` attribute.
4. Register the table in the catalog.

The dry run warns that on servers created before 10.10, 3.x may already have overwritten the `registered_on` of superseded snapshots. That can't be repaired.

#### MongoDB events: in place, fenced first

1. **Lease:** `insertOne({ _id: 'lock:migrate:<t>', kind: 'lock', expiresAt: now + 10 min })` into the catalog. A duplicate means `blocked`, unless the lease has expired or `force` is set.
2. **Fence:** `collMod` with the v2 validator. Every 3.x insert now fails with `121`. Nothing updates existing documents until step 3, whose updates make them valid.
3. **Numbering:** a client-side keyset over `find({}, { projection: { _id: 1 } }).sort({ eventDate: 1, _id: 1 }).allowDiskUse(true)` (with the hint `{ eventDate: 1, _id: 1 }` if that index exists) assigns `++p`, in unordered `bulkWrite` batches of 1,000 `updateOne({ _id }, { $set: { globalPosition: Long(p) } })`, reporting `onProgress`.
   - It is deterministic, so a rerun computes identical positions.
   - If S2 (see [Evidence](#evidence)) shows more than 10 minutes for 10 million documents, the MongoDB schema v2 PR implements the server-side pipeline instead: `$project` a key `$concat(eventDate, '#', _id)`, then `$setWindowFields` with `sortBy: { key: 1 }` and `$documentNumber`, then `$merge` into the same collection.
4. `createIndex({ globalPosition: 1 }, { unique: true })`.
5. Upsert the catalog document (`schemaVersion: 2`, `$max` of `lastPosition`). **This is the commit point: 4.0 can run from here.**
6. Clean up: drop the indexes whose key contains `eventDate` (found by key pattern), then `updateMany({ eventDate: { $exists: true } }, { $unset: { eventDate: '' } })`. Resumable.
7. Release the lease.

#### MongoDB snapshots

1. `updateMany({ latest: null }, { $unset: { latest: '' } })`.
2. Keep only the highest-version flag per `latest` value, and re-flag the streams without one.
3. Create `latest_unique`, partial on `{ latest: { $type: 'string' } }`.
4. Drop `aggregateName_1_latest_1`.

#### Runbook

Published in each `integrations/<db>` docs page and in the 4.0 guide's data migration section:

1. Take a backup.
2. Deploy nothing yet. Run `XEventStore.migrate(config, { dryRun: true })` and `XSnapshotStore.migrate(config, { dryRun: true })`, and review `blocking`, `gappedStreams` and the time zone facts.
3. **Stop every 3.x instance.**
4. Run `migrate()` for the events, then for the snapshots.
5. Deploy 4.0.
6. MariaDB: drop the `__es_v1` backups when satisfied.

A gapped stream conflicts on its next append in 4.0. ADR 0001 gives the fix: 4.x `loadFromEnvelopes`, or an append with the actual head as the expected version.

## Owner decisions

Defaults are applied. They must be decided before the MariaDB schema v2 PR merges, because changing either one later costs users a second data migration.

1. **MariaDB binary collation (`utf8mb4_bin`) for v2 tables.** *Default: binary.*
   - It makes stream ids case-sensitive, like PostgreSQL, MongoDB and in-memory, and gives a deterministic binary cursor order.
   - Users whose 3.x MariaDB relied on case-insensitive ids (`Acc-1` = `acc-1`) see those streams split after the migration. The dry run reports how many (`caseVariantStreams`).
   - Reversing it later needs another table rebuild.
   - *Alternative:* keep the server's default collation per table. That keeps the case-insensitive semantics and makes MariaDB's cursor order locale-dependent.
2. **Catalog name `event_sourcing_collections`**, one table or collection per schema or database. *Default: this name.*
   - Renaming it after 4.0 users have migrated needs a migration.
   - *Alternative:* an `ocoda_`-prefixed name.

## Evidence

Each driver's schema v2 PR fills its subsection. Until then a driver claims nothing beyond `'best-effort'`.

- **S1, position stress:** 8 writers × 200 appends of 1–3 events, with a tailing keyset reader that asserts exactly-once delivery and strictly increasing positions, plus a deliberately broken reserve → sleep → commit variant that must be caught. Reports appends per second per pool.
- **S2, migration timing:** synthetic v1 tables of 1 and 10 million rows. Reports the duration, the locks held, peak disk use and WAL or binlog volume, for the runbook's "minutes per million rows".
- **CI:** `read-all-gap-safe` on every CI version of the database, the migration specs (§6, including crash injection) and the cross-version fixture (3.0.2 writes, 4.0 migrates, reads and appends).

### PostgreSQL

*Pending.* S1 and S2 results; `read-all-gap-safe` on PostgreSQL 13 to 17 (and 18 once it is in CI); the `relfilenode` check of the type widening.

### MariaDB

*Pending.* S1 and S2 results; `read-all-gap-safe` on 10.11, 11.4 and 11.8; the InnoDB source citation (MariaDB 10.11 `trx0trx.cc`, `trx_t::commit_in_memory`) showing that a committing transaction leaves the read-view set before its locks are released; the `occurred_on` repair counts of the cross-version fixture.

### MongoDB

*Pending.* S1 and S2 results, including WriteConflict retry counts under 8 writers on a replica set and client-side against server-side numbering; `read-all-gap-safe` on replica sets of MongoDB 6, 7 and 8; `read-all-best-effort` on standalone servers.

## Alternatives considered

- **A counter table per pool** instead of one catalog: more objects to create, grant and clean up, and no single source for `listCollections` (D17).
- **A sequence, an identity column or `AUTO_INCREMENT`** as the position: values are handed out in allocation order but commit out of order, so a tailing reader skips late commits (ADR 0001). **A PostgreSQL identity column read behind a `pg_snapshot_xmin` fence, or an `xid8` column:** workable, but more moving parts than the counter row. Deferred; an `xid8` column can be added later without a rewrite (D19).
- **PostgreSQL shadow copy and swap:** loses OID-bound grants, publications and dependent views. In-place keeps them.
- **MariaDB in-place `ALTER` and `UPDATE`:** the backfill `UPDATE` fires the legacy `ON UPDATE` attribute, and `TIMESTAMP → DATETIME(3)` rebuilds the table anyway. Copy and swap avoids the hazard and leaves a backup.
- **MongoDB `$setWindowFields` sorted on `eventDate` and `_id`:** invalid, because `$documentNumber` needs exactly one sort key. The server-side fallback sorts on a concatenated key.
- **`withTransaction` for MongoDB appends:** retries for up to 120 s. A bounded 30 s loop fails faster and reports the last error.
- **An online, multi-phase migration:** many more states to test. 4.0 guarantees an offline migration only; an online "prepare" phase is additive later (MariaDB `INVISIBLE` columns and PostgreSQL nullable columns make it possible) (D30).
- **Keeping MariaDB's case-insensitive collation:** see [owner decision 1](#owner-decisions).

## Consequences

**Positive**

- Every built-in store has a per-pool global order. It is gap-safe on the SQL stores and on MongoDB replica sets where the [evidence](#evidence) holds (MariaDB: InnoDB, not Galera), so 4.x subscriptions, projections and the outbox can checkpoint it, and each claim is backed by a conformance case.
- One catalog lists collections, registers schema versions and counts positions, and `ensureCollection` heals counter drift.
- 3.x writers that are still running after the migration fail loudly instead of writing rows without positions.
- MariaDB `occurred_on` values that 3.x truncated to the second or shifted by a time zone are restored to the millisecond where the ULID proves the value.
- Appends are no longer limited to about 6,500 events on PostgreSQL.

**Negative**

- Appends within a pool serialize on its counter row. Pools are the unit of write scale, and the docs say so with the S1 numbers.
- The migration is offline, rewrites every event row (PostgreSQL, MongoDB) or copies every event table (MariaDB), and holds an exclusive lock per table while it runs.
- MariaDB stream ids become case-sensitive (owner decision 1).
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
