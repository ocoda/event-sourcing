# @ocoda/event-sourcing

## 4.0.0-next.0

### Major Changes

- [#543](https://github.com/ocoda/event-sourcing/pull/543) [`95b19f2`](https://github.com/ocoda/event-sourcing/commit/95b19f2a6e3681f4968795f2c83749c6e88f83e5) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Move to NestJS 12 and publish the packages as ES modules only.
  
  **Breaking changes**
  
  - **NestJS 12 only.** The core peers on `@nestjs/common` and `@nestjs/core` `^12.0.0` and on `rxjs` `^7.8.0`. NestJS 11 applications stay on 3.x, which keeps receiving fixes.
  - **ESM-only.** Every package ships one ES module build (`"type": "module"`), and its `exports` map points `import`, `require` and `default` at the same file. ESM applications import the packages as before. CommonJS applications, including TypeScript compiled to CommonJS, keep using `require()`: Node.js 22.12 and later load ES modules through `require()` natively. Because there is no second CommonJS build, Nest never sees two copies of a class such as `EventStore`.
  - **Node.js 22.12 or later** is required (`engines.node` is `>=22.12`).
  - **The database drivers are peer dependencies.** The integrations no longer install their driver, so install it next to the integration, in the version you choose:
    - `@ocoda/event-sourcing-postgres`: `pg` (`^8.15.0`, the first release with an ES module entry) and `pg-cursor` (`^2.14.0`). TypeScript projects also need `@types/pg` and `@types/pg-cursor`.
    - `@ocoda/event-sourcing-mongodb`: `mongodb` (`^6.10.0 || ^7.0.0`).
    - `@ocoda/event-sourcing-mariadb`: `mariadb` (`^3.0.0`).
  - The integrations now peer on `@nestjs/common` `^12.0.0` and on `@ocoda/event-sourcing` with a caret range (`^4.0.0`) instead of an exact version. They no longer list `@nestjs/core`, `rxjs` or `reflect-metadata`, which they do not import.
  - **The root entry shims are gone.** The `index.js`, `index.d.ts` and `index.ts` files next to each `package.json` were removed, and `exports` exposes only the package root and `package.json`. Import from the package name (`@ocoda/event-sourcing`, `@ocoda/event-sourcing-postgres`, ...); paths into the package, such as `@ocoda/event-sourcing/dist/...`, no longer resolve.
  
  The stored event and snapshot formats are unchanged, so no data migration is needed.
  
  **Migrating from 3.x**
  
  1. Upgrade the application to NestJS 12 and Node.js 22.12 or later.
  2. Install the driver of every integration you use, for example `npm install pg pg-cursor` for PostgreSQL or `npm install mongodb` for MongoDB.
  3. Replace any import of a path inside the packages with an import from the package name.
  4. CommonJS applications need no code changes. A test runner with its own module loader, such as Jest, loads these packages with the same setup it needs for NestJS 12, which is ESM-only as well.
  
  The DynamoDB store (`@ocoda/event-sourcing-dynamodb`) is not released for 4.0, because DynamoDB can't give the events the gap-free global order that the 4.0 read side relies on. To keep using DynamoDB, stay on 3.x, which keeps receiving fixes, or move to the PostgreSQL, MariaDB or MongoDB store.

- [#548](https://github.com/ocoda/event-sourcing/pull/548) [`c87efea`](https://github.com/ocoda/event-sourcing/commit/c87efea2581cf403012672d2dd4e02688541e5a0) Thanks [@drieshooghe](https://github.com/drieshooghe)! - 4.0 is the next major release: NestJS 12, ESM-only packages, Node.js 22.12 or later, and more. Every breaking change has its own entry in this changelog, with the steps to migrate from 3.x.

### Patch Changes

- [#540](https://github.com/ocoda/event-sourcing/pull/540) [`c9b66f7`](https://github.com/ocoda/event-sourcing/commit/c9b66f702081e5fa0a39f0d7f714a4ba87b184ef) Thanks [@drieshooghe](https://github.com/drieshooghe)! - `InMemoryEventStore.appendEvents` now rejects an append whose first version already exists with an `EventStoreVersionConflictException`. Before, appending two events at version 4 to a stream at version 3 stored a second event with version 3. The database stores already reject this through their unique (stream, version) key.

## 3.0.1

### Patch Changes

- [#524](https://github.com/ocoda/event-sourcing/pull/524) [`c2f0b47`](https://github.com/ocoda/event-sourcing/commit/c2f0b479ad295d0c92b1cf3c522bac23424c8c81) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Fix reliability issues in the core package:

  - **Event subscribers are isolated.** Before this fix, if an `@EventSubscriber` threw or returned a rejected promise, that subscriber was unsubscribed for good and the error was rethrown as an uncaught exception, which crashed the process. Now the error is logged (logger context `EventBus`, with the event and subscriber name). The subscriber keeps receiving later events, and other subscribers are unaffected.
  - **Publishing can no longer fail an append after the events are persisted.** If an `@EventPublisher` throws or rejects (async publishers were never awaited, so a rejection crashed the process), the error is now logged. The remaining publishers and envelopes are still published, and `appendEvents` resolves.
  - **Appending before publishing is wired no longer throws.** The event store's publish function is set when the application bootstraps (`onApplicationBootstrap`). When `appendEvents` runs before that, for example on a store used outside of a bootstrapped application, the events are persisted and returned but not published, and a single warning is logged. Before, the append threw a `TypeError` after the events had already been persisted.
  - **`EventSourcingModule.forRootAsync({ useClass })` works.** The module now instantiates the options factory class itself, resolving its dependencies from `imports` and global modules. If the class is already provided (for example exported by one of the `imports`, which used to be required), that instance is still reused. `forRootAsync()` also throws a descriptive error when none of `useFactory`, `useClass`, `useExisting` or `useValue` is given.
  - **In-memory stores.** `ensureCollection()` only creates missing pools and no longer wipes an existing pool's events or snapshots. `disconnect()` no longer throws when the store was never connected. `InMemorySnapshotStore.getLastEnvelopesForAggregate` now pages correctly: results stay filtered by aggregate and sorted in descending stream order, and `aggregateId` works as an exclusive "after" cursor, so pages don't overlap.
  - **Snapshots are no longer skipped when a save jumps over an interval boundary** (for example from v9 to v11 with interval 10). `SnapshotRepository.save` uses the versions recorded by the aggregate's last `commit()`. It takes a snapshot when those committed events cross an interval boundary or the first version, so a new aggregate created with several events now gets its first snapshot. When the committed versions are unknown, the previous rule applies (version 1 and multiples of the interval).
  - **Subscribing to a bus now emits values.** `eventBus.pipe(...)` and `commandBus.subscribe(...)` used to produce nothing. Now they receive the published envelopes, commands and queries, as they do in `@nestjs/cqrs`. The existing subject$ getter keeps working.
  - **The default `until` month of `getAllEnvelopes` is computed in UTC,** so events of the current UTC month are no longer missed in timezones behind UTC.
  - **`InMemoryEventStore` and `InMemorySnapshotStore` are exported from the package root,** together with their config and entity types.

## 3.0.0

### Minor Changes

- [#474](https://github.com/ocoda/event-sourcing/pull/474) [`6290979`](https://github.com/ocoda/event-sourcing/commit/6290979d9727a1edbede492c19a330ddef5ba736) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Add feature-module registration helpers, exploration service, and flexible store configuration for event sourcing.

### Patch Changes

- [#474](https://github.com/ocoda/event-sourcing/pull/474) [`7a14fea`](https://github.com/ocoda/event-sourcing/commit/7a14feab663e0d0f323b017127e2771aae6b9183) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Expand shared E2E coverage, align integration test structure, and add core bus edge-case tests.

## 2.1.4

### Patch Changes

- [#445](https://github.com/ocoda/event-sourcing/pull/445) [`44b1c31`](https://github.com/ocoda/event-sourcing/commit/44b1c311f06bbc800997934d0c18401f4b214895) Thanks [@renovate](https://github.com/apps/renovate)! - Update all non-major dependencies

- [#450](https://github.com/ocoda/event-sourcing/pull/450) [`0ca4ef4`](https://github.com/ocoda/event-sourcing/commit/0ca4ef4cd413f0196f09917d6037b76604fc00f1) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Fix serializing event payloads to save to Postgres

## 2.1.3

### Patch Changes

- [#442](https://github.com/ocoda/event-sourcing/pull/442) [`c8762dc`](https://github.com/ocoda/event-sourcing/commit/c8762dcb54b2be608b85d4dfb80b7f0880ee828d) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Bump dependencies

## 2.1.2

### Patch Changes

- [#433](https://github.com/ocoda/event-sourcing/pull/433) [`d645eaa`](https://github.com/ocoda/event-sourcing/commit/d645eaac2b7aca74303eb2908c6af64bd3491d92) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Bump dependencies

## 2.1.1

### Patch Changes

- [#422](https://github.com/ocoda/event-sourcing/pull/422) [`2711e2e`](https://github.com/ocoda/event-sourcing/commit/2711e2e3d26b1ee5ea76e6c0922e92f86ef74a4b) Thanks [@MartinLG-LaFourche](https://github.com/MartinLG-LaFourche)! - # Enhancements
  Enforces the linter to check for strictNullChecks.

  # Dependencies

  Updated various dependencies to their latest versions.

## 2.1.0

### Minor Changes

- [#419](https://github.com/ocoda/event-sourcing/pull/419) [`cbc7b08`](https://github.com/ocoda/event-sourcing/commit/cbc7b082555cb0855cd26965020b152c679e6e47) Thanks [@drieshooghe](https://github.com/drieshooghe)! - # Fixes
  Fixes an issue where the metadata from custom event-serializers wasn't returned as an object, resulting in them not being registered by the handlers loader.

  # Deprecates

  Removes the `disableDefaultSerializer` option from the module, but falls back to the default serializer for each event that doesn't have a custom event-serializer registered. Refactored because the previous behavior left the event-serializer for an event empty, which doesn't make sense.

  # Dependencies

  Updated various dependencies to their latest versions, including:

  - `@aws-sdk/client-dynamodb` & `@aws-sdk/util-dynamodb` to `3.758.0`
  - `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, and `@nestjs/testing` to `11.0.11`
  - `@changesets/changelog-github` & `@changesets/cli` to their latest versions
  - `@faker-js/faker` to `9.5.1`
  - `@swc/core` to `1.11.5`
  - `mongodb` to `6.14.0`
  - `next` to `15.2.0`
  - `pg` to `8.13.3` and `pg-cursor` to `2.12.3`
  - `rxjs` to `7.8.2`
  - `tsup` to `8.4.0`
  - `turbo` to `2.4.4`
  - `typescript` to `5.8.2`

  These updates include minor fixes, performance improvements, and compatibility enhancements.

## 2.0.0

### Major Changes

- [#406](https://github.com/ocoda/event-sourcing/pull/406) [`d22f846`](https://github.com/ocoda/event-sourcing/commit/d22f8463febe06e43282a10c6fcafdd43a9877e7) Thanks [@renovate](https://github.com/apps/renovate)! - Major bump NestJS dependencies

  - Drops support for NodeJS 18 as it is no longer supported by NestJS v11
  - Bumps dev dependencies

## 1.1.6

### Patch Changes

- [#407](https://github.com/ocoda/event-sourcing/pull/407) [`475513a`](https://github.com/ocoda/event-sourcing/commit/475513a6eaa92d3e8e8b2383f539a7518264fd5b) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

## 1.1.5

### Patch Changes

- [#402](https://github.com/ocoda/event-sourcing/pull/402) [`2ea7e18`](https://github.com/ocoda/event-sourcing/commit/2ea7e1849fe3ac4b623246b7662f0e6480be4594) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

## 1.1.4

### Patch Changes

- [#400](https://github.com/ocoda/event-sourcing/pull/400) [`f83eb04`](https://github.com/ocoda/event-sourcing/commit/f83eb045648f107282761f807d870f8844df2bd9) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

## 1.1.3

### Patch Changes

- [#393](https://github.com/ocoda/event-sourcing/pull/393) [`4375b25`](https://github.com/ocoda/event-sourcing/commit/4375b25ea95ec6dd954ae6f34d8e3797ebbefb36) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

## 1.1.2

### Patch Changes

- [#388](https://github.com/ocoda/event-sourcing/pull/388) [`154d20a`](https://github.com/ocoda/event-sourcing/commit/154d20ae3a4845e273c47d970c1b2f3f25daf1f0) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

## 1.1.1

### Patch Changes

- [#384](https://github.com/ocoda/event-sourcing/pull/384) [`9f9af0e`](https://github.com/ocoda/event-sourcing/commit/9f9af0e3bfa36239121886635013ca515f38b09f) Thanks [@renovate](https://github.com/apps/renovate)! - Update dependencies

## 1.1.0

### Minor Changes

- [#371](https://github.com/ocoda/event-sourcing/pull/371) [`eff4abd`](https://github.com/ocoda/event-sourcing/commit/eff4abda2b44a7fbcb1be7bccde7fc9267e7fded) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Support for a getAllEnvelopes method on the EventStore

## 1.0.2

### Patch Changes

- [#361](https://github.com/ocoda/event-sourcing/pull/361) [`5be1d42`](https://github.com/ocoda/event-sourcing/commit/5be1d42d1eb0a19a252d2127b72a756b3cd701f6) Thanks [@renovate](https://github.com/apps/renovate)! - Dependency updates

## 1.0.1

### Patch Changes

- [#362](https://github.com/ocoda/event-sourcing/pull/362) [`8081e16`](https://github.com/ocoda/event-sourcing/commit/8081e16d3edcab21efa301a7e1261cfd062ab4e7) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Introduce ULID based event-ids and make sure these are persisted/retrieved correctly within the integrations

- [#362](https://github.com/ocoda/event-sourcing/pull/362) [`94e41eb`](https://github.com/ocoda/event-sourcing/commit/94e41ebea9a5d3762d39db0a3afb664bc0d78010) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Adds a `listCollections` method to all integrations

## 1.0.0

### Major Changes

- This marks the first stable release of the library, which consists of the following changes:

  - all database-specific libraries have been migrated to their own libraries to reduce the bundle size
  - the `SnapshotHandler` was renamed to `SnapshotRepository`
  - the `SnapshotRepository` was provided with additional methods for retrieving snapshots in bulk
  - the database drivers were optimized (e.g. by only fetching the needed fields)
  - the DynamoDB snapshot-store serialization was fixed
