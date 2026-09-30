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

- **Node.js ≥ 22.12**, which the test and build tooling requires. `.node-version` names 24 for version managers.
- **pnpm 12**: use the exact version pinned in the root `package.json` (`packageManager`). `corepack enable` picks it up with Corepack 0.34.6 or later (`corepack --version`); the Corepack bundled with older Node releases can't run pnpm 12, so update it first with `npm install --global corepack@latest`. pnpm doesn't switch to that version on its own in this repository (`pmOnFail: ignore` in `pnpm-workspace.yaml`), so with another pnpm, run `pnpm self-update <version>` first.
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
| `fixtures/cross-version` | the 3.0.2 writer of `pnpm test:cross-version` (npm, outside the workspace)   |
| `scripts/`               | the package-shape checks (`check:packages`, `test:consumers`) and `test:cross-version` |

## Dependencies

`pnpm-workspace.yaml` sets the dependency policy: versions that several packages share come from its `catalog` (write `catalog:` in `package.json`), pnpm installs only versions that are at least a day old, and a dependency install script runs only when `allowBuilds` sets that package to `true` (an unlisted package with one fails the install).

[Renovate](https://docs.renovatebot.com) (`renovate.json5`) proposes updates once a version is 3 days old. Patch and minor updates of the tooling merge on their own once `ci-ok` is green. The peer dependency ranges of the published packages don't follow the newest driver: Renovate widens them, and only their devDependency copies move.

Every dependency stays on its newest version, so `pnpm outdated -r` lists only these intentional exceptions:

| Dependency | Stays on | Why |
| --- | --- | --- |
| `@types/node` | 22.x | The types follow the lowest Node.js the packages support (`engines.node` `>=22.12`), so they never offer an API that Node 22 lacks. Raise it together with `engines.node`; Renovate's `allowedVersions` for `@types/node` enforces it. |
| `typescript` in `docs/` | 6.x (the `ts6` catalog) | `astro check` (`@astrojs/check`) type-checks through the TypeScript JS API, which TypeScript 7 doesn't ship. Renovate keeps the `ts6` catalog below 7. |

The 3.0.2 writer in `fixtures/cross-version/v3` pins the published 3.0.2 packages and their NestJS 11 peers on purpose. It is outside the workspace, so `pnpm outdated -r` doesn't list it, and Renovate ignores it.

## Databases for integration tests

Core tests need no database. Integration tests run against the services in `docker-compose.yml`, one per database version:

| Service              | Versions                                        |
| -------------------- | ----------------------------------------------- |
| `postgres`           | `postgres-14` … `postgres-18` (`postgres` is 14) |
| `mongodb`            | `mongodb-7`, `mongodb-8` (the newest 8.x, 8.3), `mongodb-9` (9.0) (`mongodb` is 8) |
| MongoDB replica sets | `mongodb-7-rs` … `mongodb-9-rs` (port 27018) |
| `mariadb`            | `mariadb-10` (10.11), `mariadb-11` (11.4), `mariadb-11-8` (11.8), `mariadb-12` (12.3), `mariadb-rolling` (13.0) (`mariadb` is 10.11) |

The services cover the PostgreSQL and MongoDB major versions and the MariaDB long-term releases that their vendors still support, plus the newest MariaDB rolling release, which MariaDB supports only until the next one. PostgreSQL 13 and MongoDB 6 reached their end of life in 2025 and were dropped before 4.0; the `3.x` branch still tests them. `mongo:8` is the newest 8.x release, so MongoDB 8.0 has no service of its own. MongoDB 9.0 runs MongoDB's own image (`mongodb/mongodb-community-server`) until a `mongo:9` Docker Official Image exists. A new server version gets a service and a CI row of its own. The image tags float within their release line (`postgres:18` to the newest 18.x, `mongo:8` to the newest 8.x). Renovate lists a new server version on its Dependency Dashboard instead of opening a pull request. Don't approve it there: Renovate groups these updates, so the approval would move every older service to the newest version too.

Start one and wait until it is healthy:

```bash
docker compose up -d --wait postgres
```

Versions of the same database share a port, so run one version at a time.

The specs connect with the settings in `packages/testing/unit/db.ts`, whose defaults match these services. Override them with `ES_TEST_PG_*`, `ES_TEST_MARIADB_*` and `ES_TEST_MONGODB_URL`, for example to use a database of your own on a shared server (the specs use fixed table names, so two runs must not share a database).

The MongoDB unit, resilience and conformance specs run on a standalone server and, when `ES_TEST_MONGODB_RS_URL` is set, on a replica set too; the e2e suite runs on the standalone server only. CI runs both topologies in every MongoDB job and fails if `ES_TEST_MONGODB_RS_URL` is missing:

```bash
docker compose up -d --wait mongodb mongodb-8-rs
ES_TEST_MONGODB_RS_URL='mongodb://localhost:27018/?replicaSet=rs0' pnpm test:cov --filter=@ocoda/event-sourcing-mongodb
```

The cross-version test checks that a driver reads what the published 3.0.2 packages wrote: the 3.0.2 writer in `fixtures/cross-version/v3` fills a schema or database of its own, then the driver's `tests/cross-version` specs read it back. CI runs it on the oldest and the newest PostgreSQL, on the newest MongoDB, on every MariaDB long-term release, and on PostgreSQL 17 and MongoDB 8, the newest versions 3.x is tested on. It needs npm and the same `ES_TEST_*` settings (for MariaDB also the root password, to create the database):

```bash
pnpm test:cross-version --database postgres   # or mariadb, mongodb (both topologies with ES_TEST_MONGODB_RS_URL)
```

`KEEP_XV=1` keeps the namespaces and the manifests (what 3.0.2 wrote and read back) for a look afterwards; a failed run keeps the manifests.

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

The site is deployed by hand: a maintainer runs the [CD Docs](.github/workflows/cd-docs.yml) workflow on `master`. It publishes these docs at the root of the site and the 3.x docs, built from `docs/` on the `3.x` branch, under `/event-sourcing/v3/`, and checks that every link and asset of both resolves. A version select in the header links the two. To check the site without deploying it, run the workflow with `deploy` off, or on another branch; pull requests that change the workflow or `.github/scripts/docs-site.sh` build and check it too.

## Changesets

Every change to a published package needs a changeset, which becomes the CHANGELOG entry:

```bash
pnpm exec changeset
```

- Write the text for library users and call out behaviour changes.
- Pick the bump as usual: `major` for a breaking change (with a migration note), `minor` for a feature, `patch` for a fix.
- Name only the published packages: `@ocoda/event-sourcing` and the three `@ocoda/event-sourcing-<db>` integrations (`postgres`, `mongodb`, `mariadb`).
- On `3.x`, only `patch` changesets are accepted.

Docs, examples, CI and test-only changes don't need a changeset.

On `master`, the `Changesets` CI check requires a changeset when a pull request changes `lib/` or the dependencies, peer dependencies or entry points in `package.json` of `packages/core` or `packages/integration/*`. If such a change does not affect users, a maintainer can add the `no-changeset` label. Then re-run the failed jobs.

`master` releases stable 4.x versions under the npm dist-tag `latest`, and `3.x` releases its patches under `latest-3`. The release guard (`.github/scripts/release-guard.sh`) fails a `master` release for anything else, a prerelease included: entering pre mode again, for 5.0 say, is a maintainer's decision and needs a change to the guard.

## Releases

The `Release` workflow (`.github/workflows/release.yml`) runs on every push to `master` and `3.x`:

1. Its `Version` job turns the pending changesets into a version PR, `[ci] release (next)` on `master` (`[ci] release` on `3.x`), and keeps that PR up to date.
2. Merging the version PR starts a run with nothing pending. When npm lacks one of the new versions, the run's `Publish` job asks for a deployment to the `npm` environment and waits. On `master`, a `Check packages` job first checks the packed packages (publint and arethetypeswrong), so a broken package fails before anyone is asked.
3. A maintainer approves it: open the run, choose **Review deployments**, tick `npm` and choose **Approve and deploy**. The job then builds and publishes through npm trusted publishing, with provenance, and creates the git tags and GitHub releases.

Every package's npm trusted publisher names `release.yml` and the `npm` environment, so npm takes a publish only from that approved job, provided nothing else can publish. A trusted publisher without an environment would accept any workflow file called `release.yml`, from any branch and without an approval, and a token skips the workflow altogether. So on npmjs.com each package keeps exactly one trusted publisher (`ocoda/event-sourcing`, `release.yml`, environment `npm`), and its publishing access stays at **Require two-factor authentication and disallow tokens**.

To skip a release, reject the deployment; the next push that still finds unpublished versions asks again. A rejected or failed publish is retried by re-running the `Publish` job. The release guard refuses a version that is not newer than the one its dist-tag points at, so approving a re-run of an older run can't move `next` or `latest` back; it fails instead.

Approve one publish at a time: never a `master` and a `3.x` publish together. Wait until one `Publish` job has finished before approving the other, so that a 3.x patch can never race a 4.x release for `latest`.

## Conventions

The conventions that no linter enforces are in [AGENTS.md](AGENTS.md), and they apply to humans too. For example:
- keep DI-injected classes as value imports
- never deep-import from `@nestjs/*`
- store drivers must map concurrency conflicts to the core exceptions and release connections on every path

[REVIEW.md](REVIEW.md) describes how pull requests are reviewed.

## Maintenance automation

Four workflows run Claude ([claude-code-action](https://github.com/anthropics/claude-code-action)) with the skills in `.claude/skills/`. None of them is a required check, and none approves or merges anything: `ci-ok` stays the only gate.

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `claude.yml` | `@claude` in an issue, a comment or a review by an owner, member or collaborator | Answers in a comment. It may commit through the GitHub API: from an issue to a new `claude/*` branch, with a link for a maintainer to open the pull request, and on a pull request to that pull request's branch. Pull requests from forks are refused, because Claude's commit would land, with the fork's commits, on the branch of the same name in this repository. |
| `claude-review.yml` | pull requests from branches of this repository, when opened, reopened or marked ready | Reviews the change against [REVIEW.md](REVIEW.md) and [AGENTS.md](AGENTS.md) in inline comments plus one summary comment. Drafts, bots and forks are skipped. |
| `claude-deps.yml` | Renovate pull requests to `master`, when opened or retitled | Runs the `dependency-risk` skill and posts its verdict (low, medium or high, and whether a changeset is needed) as one comment, updated on each run. |
| `claude-triage.yml` | issues opened or reopened by anyone outside the maintainer team | Runs the `triage-issue` skill. It applies at most the suggested type and `area:*` labels that exist, and files the report with its draft reply as an issue in the private `ocoda/ocoda-event-sourcing-inbox` repository. Nothing is posted on the public issue. |

The workflows that read text from outside the maintainer team (issues, and the upstream release notes in Renovate pull requests) run Claude with a read-only `GITHUB_TOKEN`, and a separate job writes the result. The triage report crosses to that job encrypted, because the logs of this public repository show every step's environment. For the same reason, never re-run `claude-triage.yml` with debug logging.

They need these repository settings:

| Setting | Used by |
| --- | --- |
| secret `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`) and the [Claude GitHub App](https://github.com/apps/claude) installed on the repository | all four |
| secrets `RELEASE_APP_ID` and `RELEASE_APP_PRIVATE_KEY`: the release App, also installed on the inbox repository with the Issues read and write permission | `claude-triage.yml` |
| variable `TRIAGE_INBOX_PUBLIC_KEY` and secret `TRIAGE_INBOX_PRIVATE_KEY`: an RSA key pair that seals the triage report | `claude-triage.yml` |

To create the key pair:

```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out triage-inbox.pem
openssl pkey -in triage-inbox.pem -pubout | gh variable set TRIAGE_INBOX_PUBLIC_KEY
gh secret set TRIAGE_INBOX_PRIVATE_KEY < triage-inbox.pem
rm triage-inbox.pem
```
