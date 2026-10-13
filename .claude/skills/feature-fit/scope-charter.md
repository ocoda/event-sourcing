# Scope charter

**Status:** draft, last reviewed 2026-09-29. It was derived from the 2026-09 maintenance research (feature gaps, competitor scan, open issues). The maintainer owns this file, so review changes to it as scope decisions, like API changes. 2026-10-13: the store-driver section follows the 2026-10 database research (MySQL on the mariadb package, #646; look-alike engines, #648), and the 4.0 work moved out of the roadmap.

## Mission

`@ocoda/event-sourcing` gives NestJS applications event-sourcing and CQRS primitives with Nest-native modules, decorators and DI. It runs over pluggable stores, and every store honours one contract.

## Principles

When two options both look reasonable, these decide:

1. **Store-agnostic.** A core feature works on every store that passes the conformance suite, or it sits behind a declared store capability that users can check.
2. **Extension points over built-ins.** Prefer a hook users implement over shipping another integration: `@EventPublisher`, `@EventSerializer`, an `EventStore` subclass, or a client the user brings.
3. **Guarantees are explicit.** Concurrency, ordering and delivery guarantees are documented and tested. A feature that weakens one needs an explicit opt-in.
4. **Small footprint.** Heavy or niche dependencies go into optional peers, subpaths or separate packages, never into the hard dependencies of core.
5. **NestJS-first.** APIs follow Nest conventions: `forRoot`/`forRootAsync`/`forFeature`, decorators, injectable providers.

## Support lines

- **`master`:** v4, NestJS 12, ESM-only, Node ≥ 22.12. All new features land here.
- **`3.x`:** NestJS 11, CommonJS. Bug fixes only, released as patches. Features are not backported.

## In scope today (packages/core)

- Aggregates and events: `AggregateRoot`, `@Aggregate`, `@Event`, `@EventHandler`, ids and value objects.
- Command, query and event buses with their handler decorators.
- `EventStore` and `SnapshotStore` abstractions, `EventMap`, pluggable serialization (`@EventSerializer`), snapshots and `SnapshotRepository`.
- Optimistic concurrency and its exceptions. Pools as tenant-scoped collections.
- Publishing and subscribing: `@EventPublisher`, `@EventSubscriber`, with subscriber error isolation.
- Module wiring (`EventSourcingModule.forRoot`, `forRootAsync`, `forFeature`) and in-memory stores for tests and prototypes.

## Shipped in 4.0

- A global ordered position per pool and `readAll(fromPosition)`, with store capability flags (`atomicAppend`, `headers`, `globalOrder`).
- `appendEvents` options: `expectedVersion`, metadata (correlation and causation ids, headers) and pool.
- The store conformance suites, published as `@ocoda/event-sourcing/testing`.
- class-transformer as an optional peer (`@ocoda/event-sourcing/class-transformer`), with a JSON serializer as the default.
- Typed command and query buses.

## Roadmap: in scope, not built yet (v4 line)

- Checkpointed subscriptions and projections: catch-up, live, rebuild.
- Transactional outbox, i.e. at-least-once publishing (#467).
- Event versioning: aliases and upcasters. Events store an `eventVersion` since 4.0.
- Context propagation: tenant and trace. Headers reserve `$tenant` and `$traceparent` since 4.0.
- A conflict-retry helper, and idempotent command handling.
- Pluggable serialization with Standard Schema.
- Module-scoped `forFeature` without the process-wide static registry.
- Multi-tenancy per connection, and bring-your-own client or transaction (#455; also the need behind #458).
- A public testing kit (given/when/then).
- Observability: OpenTelemetry as an optional peer, a health indicator, graceful shutdown.
- Stream lifecycle (delete, truncate, archive), snapshot policies and snapshot schema versions.
- Parity with `@nestjs/cqrs`, method-level handlers, and dynamic event types (#456).

## In scope: store drivers (packages/integration/*)

The drivers on `master` are postgres, mongodb and mariadb, which serves MariaDB and MySQL. dynamodb ships on `3.x` only: DynamoDB can't give the events the gap-free global order that the v4 read side relies on (AGENTS.md).

A new adapter is accepted when it meets all of these:

1. **Contract.** It implements `EventStore` and `SnapshotStore` and runs the conformance suites of `@ocoda/event-sourcing/testing` from its `*.conformance.spec.ts` files. That includes mapping duplicate-key races to `EventStoreVersionConflictException` and `SnapshotStoreVersionConflictException`, and releasing connections and cursors on every path. It claims `globalOrder: 'gap-safe'` only when `read-all-gap-safe` passes on every CI version, and a negative control or a spec of its own shows that the check can fail there (ADR 0002, Evidence). A snapshot-only adapter, which implements `SnapshotStore` alone and works next to any event store, is acceptable too.
2. **CI.** It runs from `docker-compose.yml` against a matrix of vendor-supported versions. An embedded engine without a server, such as SQLite, runs against a matrix of the runtimes it ships with instead, in the jobs that `ci-ok` aggregates.
3. **Driver.** It builds on a maintained client, the vendor's own or the ecosystem's standard one (as `pg` is for PostgreSQL), and exposes that client's config type in the store config.
4. **Docs and release.** It ships with a docs page and a changeset. The maintainer seeds the npm package and its trusted publisher, because CI can't publish a package that doesn't exist yet.
5. **Owner.** The maintainer, or a named co-maintainer, commits to keeping it working.

**Wire-compatible engines.** An engine that speaks the protocol of an existing driver is served by that package, not by a new one, once it passes the package's specs in CI: MySQL runs on the mariadb package (#646). An untested look-alike is detected when the store connects and reports `'best-effort'` (#648), and the docs list it under Integrations › Other databases.

Candidates, from the 2026-10 research:
- **SQLite** (`node:sqlite`): no dependencies, and gap-safe by its single writer. It needs the embedded CI path above, a Node.js floor above 22.12, and a gap-safety spec across processes: the shared case can't fail for a synchronous store.
- **NATS JetStream 2.12+**: atomic batches and dense stream sequences. A spike first.
- **A Redis or Valkey snapshot store**: no request so far.

Not now: KurrentDB (its `$all` positions aren't dense, so they would have to be emulated, and its clustering needs a commercial licence in recent releases; one request, #158), SQL Server (no request or owner yet, and no image for local development on Apple Silicon), and CockroachDB, YugabyteDB, Cosmos DB, Firestore and Cassandra (see the docs, Integrations › Other databases).

## Out of scope

- **ORM-specific adapters** (TypeORM, Prisma, MikroORM, Sequelize, Drizzle). An event store is append-only streams, not mapped entities. The underlying need, sharing the app's connection or transaction, is served by bring-your-own client (an existing `pg.Pool`, `mariadb` pool or `MongoClient`) and custom `EventStore` subclasses.
- **UI tooling**: admin dashboards, stream browsers, visualizers. A read-only programmatic API that such tools could build on is in scope.
- **Non-NestJS frameworks and runtimes**: a framework-agnostic core, Express- or Fastify-only use, other DI containers. Running a Nest app on Bun or Deno is best-effort, not a support commitment.
- **Broker transports as built-ins** (Kafka, RabbitMQ, SNS/SQS, NATS). Use `@EventPublisher` or `@nestjs/microservices`. The outbox is what makes delivery reliable.
- **Read-model storage.** The library feeds projections. The read-model database and its schema belong to the application.
- **General-purpose workflow engines, job queues and schedulers.**
- **Backporting features to 3.x.**

## Undecided: ask the maintainer

- Process managers and sagas (#34): core, a separate package, or out.
- The relationship with `@nestjs/cqrs`: a bridge package, or rebuilding on its buses in a later major.
- A CLI or devtools (tail, replay, rebuild), non-UI only, if at all.
- Nest schematics and generators.
- Fixed versioning for all packages versus independent integration versions as the number of adapters grows.
