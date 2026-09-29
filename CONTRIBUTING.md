# Contributing to @ocoda/event-sourcing

Thanks for helping improve this project!

- Found a bug or have a feature request? Open an issue.
- Have a question? Discussions is the place.
- Found a vulnerability? Report it privately, see [SECURITY.md](SECURITY.md).

## Branches

| Branch   | Line                                           | What goes here                                         |
| -------- | ---------------------------------------------- | ------------------------------------------------------ |
| `master` | v4 (NestJS 12, ESM-only, Node ≥ 22.12; in progress) | new features, breaking changes (with a migration note) |
| `3.x`    | 3.x maintenance (NestJS 11, CommonJS)          | bug fixes only, released as patch versions             |

Base your pull request on the branch your change targets.

## Prerequisites

- **Node.js ≥ 22.12**, which the test and build tooling requires.
- **pnpm**: use the version pinned in the root `package.json` (`packageManager`); `corepack enable` picks it up.
- **Docker**, if you touch a database integration.

## Setup

```bash
git clone https://github.com/ocoda/event-sourcing.git
cd event-sourcing
pnpm install
```

The repository is a pnpm + turbo monorepo:

| Path                     | What it is                                                                   |
| ------------------------ | ---------------------------------------------------------------------------- |
| `packages/core`          | `@ocoda/event-sourcing`, the library                                         |
| `packages/integration/*` | store drivers: `postgres`, `mongodb`, `mariadb`                              |
| `packages/testing`       | shared test fixtures and the end-to-end suite every store runs (private)     |
| `packages/config`        | shared TypeScript and Vitest configuration (private)                         |
| `docs/`                  | the documentation site                                                       |
| `example/`               | an example NestJS application                                                |

## Databases for integration tests

Core tests need no database. Integration tests run against the services in `docker-compose.yml`, whose images are pinned:

| Service              | Versions                                        |
| -------------------- | ----------------------------------------------- |
| `postgres`           | `postgres-13` … `postgres-17` (`postgres` is 14) |
| `mongodb`            | `mongodb-6`, `mongodb-7`, `mongodb-8` (`mongodb` is 8) |
| `mariadb`            | `mariadb-10` (10.11), `mariadb-11` (11.4)        |

Start one and wait until it is healthy:

```bash
docker compose up -d --wait postgres
```

Versions of the same database share a port, so run one version at a time.

## Before you open a pull request

CI's `ci-ok` check is required to merge. Run the same checks locally:

```bash
pnpm run ci --filter="./packages/**"   # oxlint + oxfmt --check (pnpm format fixes formatting)
pnpm typecheck
pnpm build --filter="./packages/**"
pnpm test:cov --filter=@ocoda/event-sourcing   # coverage thresholds are enforced
```

For every integration you changed (all of them if you changed `packages/core` or `packages/testing`), start its database and run:

```bash
pnpm test:cov --filter=@ocoda/event-sourcing-postgres
```

Tests run on [Vitest](https://vitest.dev). Vite's Oxc transform applies each package's `tsconfig.json`, including the legacy decorator and `emitDecoratorMetadata` settings Nest needs. A package's tsconfig must therefore include its `tests` folder.

## Documentation

The docs site in `docs/` is built with [Starlight](https://starlight.astro.build) and deployed to GitHub Pages under `/event-sourcing`. Its pages are the MDX files in `docs/src/content/docs`, and the sidebar is defined in `docs/astro.config.ts`.

```bash
pnpm --filter @ocoda/event-sourcing-docs docs:dev     # local dev server
pnpm docs:build --filter=@ocoda/event-sourcing-docs  # the static site in docs/dist
```

- Link to other pages with root-relative links such as `/start/install#advanced-setup`. The base path is added at build time.
- Give a heading a stable anchor with `## Heading [#anchor]`.
- The build fails on a broken internal link or anchor.

## Changesets

Every change to a published package needs a changeset, which becomes the CHANGELOG entry:

```bash
pnpm exec changeset
```

- Write the text for library users and call out behaviour changes.
- On `3.x`, only `patch` changesets are accepted.

Docs, examples, CI and test-only changes don't need a changeset.

## Conventions

The conventions that no linter enforces are in [AGENTS.md](AGENTS.md), and they apply to humans too. For example:
- keep DI-injected classes as value imports
- never deep-import from `@nestjs/*`
- store drivers must map concurrency conflicts to the core exceptions and release connections on every path

[REVIEW.md](REVIEW.md) describes how pull requests are reviewed.
