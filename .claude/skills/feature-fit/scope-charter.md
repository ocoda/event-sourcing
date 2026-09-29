# Scope charter

**Status:** draft, last reviewed 2026-09-29. It was derived from the 2026-09 maintenance research (feature gaps, competitor scan, open issues). The maintainer owns this file, so review changes to it as scope decisions, like API changes.

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

## Roadmap: in scope, not built yet (v4 line)

- A global ordered position plus `readAll(fromPosition)`, with store capability flags.
- Checkpointed subscriptions and projections: catch-up, live, rebuild.
- Transactional outbox, i.e. at-least-once publishing (#467).
- Event versioning: versions, aliases, upcasters.
- Metadata and context propagation: correlation, causation, tenant, trace.
- `appendEvents` options (`expectedVersion`, metadata, pool), a conflict-retry helper, idempotent command handling.
- Pluggable serialization with Standard Schema. class-transformer becomes optional.
- Module-scoped `forFeature` without the process-wide static registry.
- Multi-tenancy per connection, and bring-your-own client or transaction (#455; also the need behind #458).
- A public testing kit (given/when/then) and an exported store conformance suite.
- Observability: OpenTelemetry as an optional peer, a health indicator, graceful shutdown.
- Stream lifecycle (delete, truncate, archive), snapshot policies and snapshot schema versions.
- Typed buses and parity with `@nestjs/cqrs`, method-level handlers, and dynamic event types (#456).

## In scope: store drivers (packages/integration/*)

The current drivers are postgres, mongodb, mariadb and dynamodb. A new adapter is accepted when it meets all of these:

1. **Contract.** It implements `EventStore` and `SnapshotStore` and passes the shared suite in `packages/testing`. That includes mapping duplicate-key races to `EventStoreVersionConflictException` and `SnapshotStoreVersionConflictException`, and releasing connections and cursors on every path.
2. **CI.** It runs from `docker-compose.yml` against a matrix of vendor-supported versions.
3. **Driver.** It builds on a maintained official client, and exposes that client's config type in the store config.
4. **Docs and release.** It ships with a docs page and a changeset. The maintainer seeds the npm package and its trusted publisher, because CI can't publish a package that doesn't exist yet.
5. **Owner.** The maintainer, or a named co-maintainer, commits to keeping it working.

Candidates: KurrentDB, SQLite (`node:sqlite`), a Redis snapshot store.

## Out of scope

- **ORM-specific adapters** (TypeORM, Prisma, MikroORM, Sequelize, Drizzle). An event store is append-only streams, not mapped entities. The underlying need, sharing the app's connection or transaction, is served by bring-your-own client (an existing `pg.Pool`, `MongoClient` or `DynamoDBClient`) and custom `EventStore` subclasses.
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
