# AGENTS.md

`@ocoda/event-sourcing` is an event sourcing / CQRS library for NestJS. This is a pnpm + turbo monorepo:
- `packages/core` is the library.
- `packages/integration/*` holds the store drivers.
- `packages/testing` is a private shared test suite.
- `packages/config` holds the private shared configs.
- `docs/` and `example/` are the docs site and example app.

Commands live in the root and package `package.json` scripts. Run the ones below before calling work done.

## Branches

- `master` is the **v4 line**: NestJS 12, ESM-only, Node ≥ 22.12, work in progress. Breaking changes are allowed here, but they need a changeset and a migration note.
- `3.x` is the **maintenance line**: NestJS 11, CommonJS. It takes patch changesets only. CI rejects anything else, because with the fixed version group and `workspace:*` peers, a `minor` there would publish an accidental major.
- The DynamoDB store (`@ocoda/event-sourcing-dynamodb`) exists on `3.x` only. It was dropped from v4 because DynamoDB can't give the events a gap-free global order, which the v4 read side relies on. The 4.0 migration guide must say so; until it exists, the note is on the docs install page.

## Done means `ci-ok` would pass

The `ci-ok` check is the only required check on `master` and `3.x`. Before opening or updating a PR, reproduce it locally:

1. `pnpm run ci --filter="./packages/**"`: oxlint (warnings fail) plus `oxfmt --check`. Run `pnpm format` to fix formatting.
2. `pnpm typecheck`
3. `pnpm build --filter="./packages/**"`
4. `pnpm test:cov --filter=@ocoda/event-sourcing`. The coverage thresholds are enforced.
5. `pnpm check:packages` (publint + arethetypeswrong on the packed tarballs) and `pnpm test:consumers` (installs the tarballs into an ESM and a CommonJS NestJS 12 app and runs them). Both matter whenever a `package.json`, a tsconfig or the public exports change.
6. For every integration you touched, and for all of them when core or `packages/testing` changed:
   - Start the database: `docker compose up -d --wait <service>`. Service names are in `docker-compose.yml`, e.g. `postgres`, `mongodb`, `mariadb`.
   - Then run `pnpm test:cov --filter=@ocoda/event-sourcing-<db>`.
   - Connection settings come from `packages/testing/unit/db.ts` (`ES_TEST_*` variables, defaults match the compose services). For MongoDB, CI also sets `ES_TEST_MONGODB_RS_URL=mongodb://localhost:27018/?replicaSet=rs0` (service `mongodb-N-rs`; required when `CI` is set): the unit, resilience and conformance specs run on both topologies, e2e on the standalone server.
   - Driver specs build stores only through `packages/integration/<db>/tests/support/stores.ts` (`createEventStore`, `createSnapshotStore`).

## Invariants that no config enforces

- **DI imports stay value imports.** A class that Nest injects by type must be imported as a value, never with `import type`, or `design:paramtypes` loses it. That is why `typescript/consistent-type-imports` is off.
- **Import `@nestjs/*` only from the package root.** oxlint rejects deep imports like `@nestjs/core/injector/*`, because they don't resolve through the NestJS 12 exports map.
- **One ESM build, no bundler.** `tsc -p tsconfig.build.json` (TypeScript 7) compiles each published package file by file into `dist/`, and `exports` points `import`, `require` and `default` at that one file. Never add a second CommonJS build: Nest DI would see two copies of every class. Relative imports spell out the emitted file (`./event-store.js`, `./helpers/index.js`).
- **DB drivers are peer dependencies** of the integrations, with a devDependency copy for the tests. Widen or narrow a peer range only with a changeset.
- **Dependencies follow `pnpm-workspace.yaml` (pnpm 12).** A version that several workspace packages share lives in its `catalog` and is written `catalog:`; peer ranges of the published packages stay explicit. pnpm installs only versions at least a day old and rejects trust downgrades, and every install re-checks the whole lockfile against both, in CI too. A dependency with an install script fails the install until it is reviewed and listed under `allowBuilds`.
- **Class fields use define semantics.** `useDefineForClassFields` is true, the same as the published build; the tests assert it.
- **Store drivers share one contract.** `EventStore` and `SnapshotStore` subclasses must map duplicate-key races to `EventStoreVersionConflictException` / `SnapshotStoreVersionConflictException` and release connections and cursors on every path, including an early `break`. A driver change needs a test that fails without it. The conformance suites in `packages/core/lib/testing` (published as `@ocoda/event-sourcing/testing`) encode the shared contract, and every store runs them from its `*.conformance.spec.ts` files. Don't weaken a conformance assertion for one store: skip that case in the store's spec with the reason and a TODO.
- **Integration tests count rows in the default tables.** Give new tests their own pool name so parallel or leftover data can't skew the counts.

## Changesets

- Every change to a published package needs a changeset (`pnpm exec changeset`). It is the user-facing CHANGELOG entry, so write it for users and call out behaviour changes. On `master`, the `Changesets` CI job requires one when a PR changes `lib/` or the runtime fields of `package.json` in `packages/core` or `packages/integration/*`. Only a maintainer can waive that, with the `no-changeset` label.
- A changeset may only name the four published packages, never a private one.
- `master` is in changesets pre mode with the tag `next` (`.changeset/pre.json`). It releases `4.0.0-next.N` prereleases under the npm dist-tag `next`, and `latest` stays on 3.x. `.github/scripts/release-guard.sh` fails the release workflow for anything else.
- Versioned changesets move to `.changeset/pre/`. At 4.0 GA they become the 4.0.0 changelog, so fix an outdated one there.
- Keep `` $` `` out of changeset text. Changesets 2 on `3.x`, where fixes get backported, treats it as a `String.replace` pattern and corrupts the entry.

## Maintenance skills

Claude Code skills in `.claude/skills/`, each with a `SKILL.md`. Other agents can follow those files as plain instructions:
- `changeset`: drafts `.changeset/<slug>.md` for a branch or PR, with the bump per branch policy and user-facing text.
- `dependency-risk`: gives a low/medium/high verdict for a Renovate/Dependabot PR or `pkg@from..to`, and says whether a changeset is needed. Read-only.
- `triage-issue`: classifies an issue, checks released fixes and duplicates, and suggests labels and a draft reply. Posts nothing.
- `feature-fit`: gives a fits/partial/out verdict and an API sketch, judged against `.claude/skills/feature-fit/scope-charter.md`.
- `release`: the release preflight, invoked only by the maintainer with `/release`. Never publishes.

## Hard guardrails

These need a maintainer's explicit OK:
- Publishing: never run `npm publish`, `pnpm publish` or `changeset publish` locally. Only `.github/workflows/release.yml` publishes, through npm trusted publishing.
- Renaming `release.yml`: the npm trusted publisher is bound to that exact filename, so renaming it breaks publishing.
- Exiting pre mode on `master` (`changeset pre exit`) or loosening `release-guard.sh`. That is the 4.0 GA decision, and it moves `latest` to 4.x.
- Force-pushing `master` or `3.x`.
- Changing rulesets or repo settings.
