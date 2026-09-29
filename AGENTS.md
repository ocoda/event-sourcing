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

## Done means `ci-ok` would pass

The `ci-ok` check is the only required check on `master` and `3.x`. Before opening or updating a PR, reproduce it locally:

1. `pnpm run ci --filter="./packages/**"`: oxlint (warnings fail) plus `oxfmt --check`. Run `pnpm format` to fix formatting.
2. `pnpm typecheck`
3. `pnpm build --filter="./packages/**"`
4. `pnpm test:cov --filter=@ocoda/event-sourcing`. The coverage thresholds are enforced.
5. `pnpm check:packages` (publint + arethetypeswrong on the packed tarballs) and `pnpm test:consumers` (installs the tarballs into an ESM and a CommonJS NestJS 12 app and runs them). Both matter whenever a `package.json`, a tsconfig or the public exports change.
6. For every integration you touched, and for all of them when core or `packages/testing` changed:
   - Start the database: `docker compose up -d --wait <service>`. Service names are in `docker-compose.yml`, e.g. `postgres`, `mongodb`, `mariadb`, `dynamodb`.
   - Then run `pnpm test:cov --filter=@ocoda/event-sourcing-<db>`.

## Invariants that no config enforces

- **DI imports stay value imports.** A class that Nest injects by type must be imported as a value, never with `import type`, or `design:paramtypes` loses it. That is why `typescript/consistent-type-imports` is off.
- **Import `@nestjs/*` only from the package root.** oxlint rejects deep imports like `@nestjs/core/injector/*`, because they don't resolve through the NestJS 12 exports map.
- **One ESM build, no bundler.** `tsc -p tsconfig.build.json` (TypeScript 7) compiles each published package file by file into `dist/`, and `exports` points `import`, `require` and `default` at that one file. Never add a second CommonJS build: Nest DI would see two copies of every class. Relative imports spell out the emitted file (`./event-store.js`, `./helpers/index.js`).
- **DB drivers are peer dependencies** of the integrations, with a devDependency copy for the tests. Widen or narrow a peer range only with a changeset.
- **Class fields use define semantics.** `useDefineForClassFields` is true, the same as the published build; the tests assert it.
- **Store drivers share one contract.** `EventStore` and `SnapshotStore` subclasses must map duplicate-key races to `EventStoreVersionConflictException` / `SnapshotStoreVersionConflictException` and release connections and cursors on every path, including an early `break`. A driver change needs a test that fails without it. The conformance suites in `packages/testing/conformance` encode the shared contract, and every store runs them from its `*.conformance.spec.ts` files. Don't weaken a conformance assertion for one store: skip that case in the store's spec with the reason and a TODO.
- **Integration tests count rows in the default tables.** Give new tests their own pool name so parallel or leftover data can't skew the counts.

## Changesets

- Every change to a published package needs a changeset (`pnpm exec changeset`). It is the user-facing CHANGELOG entry, so write it for users and call out behaviour changes.
- Keep `` $` `` out of changeset text. The changelog generator treats it as a `String.replace` pattern and corrupts the entry.

## Hard guardrails

These need a maintainer's explicit OK:
- Publishing: never run `npm publish`, `pnpm publish` or `changeset publish` locally. Only `.github/workflows/release.yml` publishes, through npm trusted publishing.
- Renaming `release.yml`: the npm trusted publisher is bound to that exact filename, so renaming it breaks publishing.
- Force-pushing `master` or `3.x`.
- Changing rulesets or repo settings.
