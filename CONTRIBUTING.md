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
| `fixtures/consumers`     | the application `pnpm test:consumers` installs the packed packages into      |
| `scripts/`               | the package-shape checks (`check:packages`, `test:consumers`)                |

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
pnpm check:packages    # publint + arethetypeswrong on the packed tarballs
pnpm test:consumers    # installs the tarballs into an ESM and a CommonJS NestJS 12 app and runs them
```

For every integration you changed (all of them if you changed `packages/core` or `packages/testing`), start its database and run:

```bash
pnpm test:cov --filter=@ocoda/event-sourcing-postgres
```

Tests run on [Vitest](https://vitest.dev). Vite's Oxc transform applies each package's `tsconfig.json`, including the legacy decorator and `emitDecoratorMetadata` settings Nest needs. A package's tsconfig must therefore include its `tests` folder.

The packages are ESM-only and compiled file by file with TypeScript 7 (`tsc -p tsconfig.build.json`, no bundler), so relative imports spell out the emitted file: `./event-store.js`, `./helpers/index.js`. `pnpm typecheck` reports a missing extension.

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
- Pick the bump as usual: `major` for a breaking change (with a migration note), `minor` for a feature, `patch` for a fix.
- Name only the published packages: `@ocoda/event-sourcing` and the four `@ocoda/event-sourcing-<db>` integrations.
- On `3.x`, only `patch` changesets are accepted.

Docs, examples, CI and test-only changes don't need a changeset.

On `master`, the `Changesets` CI check requires a changeset when a pull request changes `lib/` or the dependencies, peer dependencies or entry points in `package.json` of `packages/core` or `packages/integration/*`. If such a change does not affect users, a maintainer can add the `no-changeset` label. Then re-run the failed jobs.

`master` is in changesets pre mode: until 4.0.0 is released, its changesets ship as `4.0.0-next.N` prereleases under the npm dist-tag `next` (`npm install @ocoda/event-sourcing@next`), and `latest` stays on 3.x. Maintainers decide when to leave pre mode for the 4.0.0 release.

## Conventions

The conventions that no linter enforces are in [AGENTS.md](AGENTS.md), and they apply to humans too. For example:
- keep DI-injected classes as value imports
- never deep-import from `@nestjs/*`
- store drivers must map concurrency conflicts to the core exceptions and release connections on every path

[REVIEW.md](REVIEW.md) describes how pull requests are reviewed.
