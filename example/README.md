# Example: a book library on PostgreSQL

A small NestJS 12 application (ES modules) that runs `@ocoda/event-sourcing` 4.0 on PostgreSQL. It has two bounded contexts, each a feature module with its own events: the **catalogue** (books and their authors) and **loaning** (book loans).

| What | Where |
| --- | --- |
| Store configuration: `forRootAsync` with `DATABASE_URL`, the default tables created on bootstrap | [`src/app.module.ts`](src/app.module.ts) |
| Events per feature module with `forFeature` | [`src/catalogue/catalogue.module.ts`](src/catalogue/catalogue.module.ts) |
| Aggregates that check their rules and change their state through events | [`src/catalogue/domain/models/book/book.aggregate.ts`](src/catalogue/domain/models/book/book.aggregate.ts) |
| Typed commands and queries (`Command<R>`, `Query<R>`) | [`src/catalogue/application/commands`](src/catalogue/application/commands), [`queries`](src/catalogue/application/queries) |
| A repository: `getUncommittedEvents()`, `appendEvents(stream, events, { expectedVersion: committedVersion })`, `markCommitted()` | [`src/catalogue/application/repositories/book.repository.ts`](src/catalogue/application/repositories/book.repository.ts) |
| Snapshots every 5 versions | [`book.snapshot-repository.ts`](src/catalogue/application/repositories/book.snapshot-repository.ts) |
| Subscribers that keep a read model | [`src/catalogue/application/projections`](src/catalogue/application/projections) |
| A publisher that receives every event | [`src/event-log/logging.event-publisher.ts`](src/event-log/logging.event-publisher.ts) |
| Reading all events in order with `readAll`, from a global position, and sending the envelopes as JSON | [`src/event-log/event-log.controller.ts`](src/event-log/event-log.controller.ts) |
| Version conflicts as `409 Conflict`, matched on the error `code` | [`src/event-sourcing-exception.filter.ts`](src/event-sourcing-exception.filter.ts) |

The guide behind it is the [documentation](https://ocoda.github.io/event-sourcing/start/install/).

## Quickstart

From the root of the repository, with Docker and Node.js 22.12 or later:

```bash
docker compose up -d --wait postgres    # PostgreSQL on 127.0.0.1:5432, user and password postgres
pnpm install
pnpm dev --filter=@ocoda/event-sourcing-example
```

`pnpm dev` builds the packages the example imports, compiles the example and starts it on port 3000. On its first start the stores create their tables (`events`, `snapshots` and the catalog `event_sourcing_collections`) in the database: with the default `ddl: 'auto'` they create what's missing, so a fresh database needs no setup. A database that 3.x wrote to has to be migrated first, offline: see [Migrating from 3.x](https://ocoda.github.io/event-sourcing/integrations/postgres/#migrating-from-3x).

| Variable | Default |
| --- | --- |
| `DATABASE_URL` | `postgres://postgres:postgres@127.0.0.1:5432/postgres`, the compose service |
| `PORT` | `3000` |

Then add a book, give it a second author and read it back:

```bash
curl -s localhost:3000/books -H 'content-type: application/json' \
  -d '{"title":"Effective Java","authorIds":[],"publicationDate":"2018-01-06","isbn":"978-0-13-468599-1"}'
# {"id":"<book id>"}

curl -s -X PUT localhost:3000/books/<book id>/authors/0b6b3f36-6c3e-4f6a-9d8f-2d4b1c8e7a10
curl -s localhost:3000/books/<book id>
curl -s localhost:3000/books              # the read model the subscribers keep
curl -s 'localhost:3000/events?from=1&limit=10'   # every event, in order; read on from "next"
```

| Endpoint | |
| --- | --- |
| `POST /books` | Adds a book. An optional `id` makes the request safe to retry: a second book with the same id gets `409`. |
| `GET /books`, `GET /books/:id` | The book list (the read model), a book (from its snapshot and events). |
| `PUT`, `DELETE /books/:id/authors/:authorId` | Adds or removes an author. |
| `DELETE /books/:id` | Removes a book, with an optional `reason` in the body. |
| `POST /loans`, `GET /loans/:id` | Lends a book (`bookId`, `libraryMemberId`, `dueOn`), reads a loan. |
| `POST /loans/:id/extend`, `POST /loans/:id/return` | Extends a loan (`dueOn`), returns the book. |
| `GET /events?from=&limit=` | The events of all streams from a global position, as the JSON of their envelopes (`{ event, payload, metadata }`), and the position to read on from. |

## Tests

[`tests/app.e2e.spec.ts`](tests/app.e2e.spec.ts) starts the application against PostgreSQL and drives it over HTTP: it adds and changes books, waits for the subscribers with `eventBus.whenIdle()`, checks the snapshots, a version conflict and the event log.

```bash
docker compose up -d --wait postgres
pnpm test --filter=@ocoda/event-sourcing-example
```

It connects with the `ES_TEST_PG_*` variables of the other database specs (see [`packages/testing/unit/db.ts`](../packages/testing/unit/db.ts)), whose defaults are the compose service, and works in a schema of its own, `example_e2e`, which it drops and creates again on every run. CI runs it on every change to `example/` or `packages/`.
