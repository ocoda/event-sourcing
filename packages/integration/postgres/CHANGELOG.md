# @ocoda/event-sourcing-postgres

## 3.0.2

### Patch Changes

- Updated dependencies [[`94b5f48`](https://github.com/ocoda/event-sourcing/commit/94b5f48415e54e3408f21c35858b431311c04462)]:
  - @ocoda/event-sourcing@3.0.2

## 3.0.1

### Patch Changes

- [#525](https://github.com/ocoda/event-sourcing/pull/525) [`2b3f689`](https://github.com/ocoda/event-sourcing/commit/2b3f689492fce4c14d7184b13349fce640a1eac9) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Fix connection handling, concurrency errors and index creation in the Postgres stores.

  - The stores no longer run everything over a single long-lived connection. Single queries use the pool, transactions and each `getEvents`/`getEnvelopes`/`getAllEnvelopes`/`getSnapshots`/`getLastEnvelopesForAggregate`/`listCollections` iteration check out their own connection, and cursors are always closed. A read gives its connection back as soon as its last rows are fetched, so calling the store while processing them doesn't need a second connection, and a read that fits in one batch never holds a connection after it returns its rows. Breaking out of a `for await` loop, throwing inside it, an unregistered event, or calling the store from inside a loop no longer leaves the store hanging. Under load a store can now open up to the pool's `max` connections (10 by default) instead of one; set `max` in the store options if you need a lower limit. A connection that drops is now discarded instead of crashing the process, and a dropped idle connection is logged. `disconnect()` now waits for reads that are still in progress to finish or be closed.
  - A concurrent append of the same version now throws `EventStoreVersionConflictException` / `SnapshotStoreVersionConflictException` instead of a persistence exception, so it can be retried.
  - `appendSnapshot` now checks the version, moves the `latest` flag and inserts the snapshot in one transaction that is serialized per stream. A failed append no longer leaves a stream without a latest snapshot, and concurrent appends can't flag two snapshots as latest.
  - `ensureCollection` now runs its DDL in one transaction under an advisory lock, so application instances that boot at the same time no longer race each other. It no longer issues `CREATE TABLE` for a collection that already exists.
  - Secondary indexes now get a name derived from their table (e.g. `idx_<pool>-events_event_date_id`). Before, index names were shared across the schema, so only the first collection got its `(event_date, event_id)` or `(aggregate_name, latest)` index and every other pool got none. New collections now get their index. Existing collections are not changed, because building an index blocks writes to a large table. When an existing collection has no such index, a warning is logged at startup with the `CREATE INDEX CONCURRENTLY` statement to run. Existing indexes are recognized by their columns, whatever their name, and are never dropped or renamed.
  - Collection names are now escaped as SQL identifiers, so pool names containing characters such as `"` work. Names without special characters behave exactly as before.

- Updated dependencies [[`c2f0b47`](https://github.com/ocoda/event-sourcing/commit/c2f0b479ad295d0c92b1cf3c522bac23424c8c81)]:
  - @ocoda/event-sourcing@3.0.1

## 3.0.0

### Patch Changes

- [#474](https://github.com/ocoda/event-sourcing/pull/474) [`7a14fea`](https://github.com/ocoda/event-sourcing/commit/7a14feab663e0d0f323b017127e2771aae6b9183) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Expand shared E2E coverage, align integration test structure, and add core bus edge-case tests.

- Updated dependencies [[`6290979`](https://github.com/ocoda/event-sourcing/commit/6290979d9727a1edbede492c19a330ddef5ba736), [`7a14fea`](https://github.com/ocoda/event-sourcing/commit/7a14feab663e0d0f323b017127e2771aae6b9183)]:
  - @ocoda/event-sourcing@3.0.0

## 2.1.4

### Patch Changes

- [#445](https://github.com/ocoda/event-sourcing/pull/445) [`44b1c31`](https://github.com/ocoda/event-sourcing/commit/44b1c311f06bbc800997934d0c18401f4b214895) Thanks [@renovate](https://github.com/apps/renovate)! - Update all non-major dependencies

- [#450](https://github.com/ocoda/event-sourcing/pull/450) [`0ca4ef4`](https://github.com/ocoda/event-sourcing/commit/0ca4ef4cd413f0196f09917d6037b76604fc00f1) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Fix serializing event payloads to save to Postgres

- Updated dependencies [[`44b1c31`](https://github.com/ocoda/event-sourcing/commit/44b1c311f06bbc800997934d0c18401f4b214895), [`0ca4ef4`](https://github.com/ocoda/event-sourcing/commit/0ca4ef4cd413f0196f09917d6037b76604fc00f1)]:
  - @ocoda/event-sourcing@2.1.4

## 2.1.3

### Patch Changes

- [#442](https://github.com/ocoda/event-sourcing/pull/442) [`c8762dc`](https://github.com/ocoda/event-sourcing/commit/c8762dcb54b2be608b85d4dfb80b7f0880ee828d) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Bump dependencies

- Updated dependencies [[`c8762dc`](https://github.com/ocoda/event-sourcing/commit/c8762dcb54b2be608b85d4dfb80b7f0880ee828d)]:
  - @ocoda/event-sourcing@2.1.3

## 2.1.2

### Patch Changes

- [#433](https://github.com/ocoda/event-sourcing/pull/433) [`d645eaa`](https://github.com/ocoda/event-sourcing/commit/d645eaac2b7aca74303eb2908c6af64bd3491d92) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Bump dependencies

- Updated dependencies [[`d645eaa`](https://github.com/ocoda/event-sourcing/commit/d645eaac2b7aca74303eb2908c6af64bd3491d92)]:
  - @ocoda/event-sourcing@2.1.2

## 2.1.1

### Patch Changes

- [#422](https://github.com/ocoda/event-sourcing/pull/422) [`2711e2e`](https://github.com/ocoda/event-sourcing/commit/2711e2e3d26b1ee5ea76e6c0922e92f86ef74a4b) Thanks [@MartinLG-LaFourche](https://github.com/MartinLG-LaFourche)! - # Enhancements
  Enforces the linter to check for strictNullChecks.

  # Dependencies

  Updated various dependencies to their latest versions.

- Updated dependencies [[`2711e2e`](https://github.com/ocoda/event-sourcing/commit/2711e2e3d26b1ee5ea76e6c0922e92f86ef74a4b)]:
  - @ocoda/event-sourcing@2.1.1

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

### Patch Changes

- Updated dependencies [[`cbc7b08`](https://github.com/ocoda/event-sourcing/commit/cbc7b082555cb0855cd26965020b152c679e6e47)]:
  - @ocoda/event-sourcing@2.1.0

## 2.0.0

### Major Changes

- [#406](https://github.com/ocoda/event-sourcing/pull/406) [`d22f846`](https://github.com/ocoda/event-sourcing/commit/d22f8463febe06e43282a10c6fcafdd43a9877e7) Thanks [@renovate](https://github.com/apps/renovate)! - Major bump NestJS dependencies

  - Drops support for NodeJS 18 as it is no longer supported by NestJS v11
  - Bumps dev dependencies

### Patch Changes

- Updated dependencies [[`d22f846`](https://github.com/ocoda/event-sourcing/commit/d22f8463febe06e43282a10c6fcafdd43a9877e7)]:
  - @ocoda/event-sourcing@2.0.0

## 1.1.6

### Patch Changes

- [#407](https://github.com/ocoda/event-sourcing/pull/407) [`475513a`](https://github.com/ocoda/event-sourcing/commit/475513a6eaa92d3e8e8b2383f539a7518264fd5b) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

- Updated dependencies [[`475513a`](https://github.com/ocoda/event-sourcing/commit/475513a6eaa92d3e8e8b2383f539a7518264fd5b)]:
  - @ocoda/event-sourcing@1.1.6

## 1.1.5

### Patch Changes

- [#402](https://github.com/ocoda/event-sourcing/pull/402) [`2ea7e18`](https://github.com/ocoda/event-sourcing/commit/2ea7e1849fe3ac4b623246b7662f0e6480be4594) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

- Updated dependencies [[`2ea7e18`](https://github.com/ocoda/event-sourcing/commit/2ea7e1849fe3ac4b623246b7662f0e6480be4594)]:
  - @ocoda/event-sourcing@1.1.5

## 1.1.4

### Patch Changes

- [#400](https://github.com/ocoda/event-sourcing/pull/400) [`f83eb04`](https://github.com/ocoda/event-sourcing/commit/f83eb045648f107282761f807d870f8844df2bd9) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

- Updated dependencies [[`f83eb04`](https://github.com/ocoda/event-sourcing/commit/f83eb045648f107282761f807d870f8844df2bd9)]:
  - @ocoda/event-sourcing@1.1.4

## 1.1.3

### Patch Changes

- [#393](https://github.com/ocoda/event-sourcing/pull/393) [`4375b25`](https://github.com/ocoda/event-sourcing/commit/4375b25ea95ec6dd954ae6f34d8e3797ebbefb36) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

- Updated dependencies [[`4375b25`](https://github.com/ocoda/event-sourcing/commit/4375b25ea95ec6dd954ae6f34d8e3797ebbefb36)]:
  - @ocoda/event-sourcing@1.1.3

## 1.1.2

### Patch Changes

- [#388](https://github.com/ocoda/event-sourcing/pull/388) [`154d20a`](https://github.com/ocoda/event-sourcing/commit/154d20ae3a4845e273c47d970c1b2f3f25daf1f0) Thanks [@renovate](https://github.com/apps/renovate)! - Patch update dependencies

- Updated dependencies [[`154d20a`](https://github.com/ocoda/event-sourcing/commit/154d20ae3a4845e273c47d970c1b2f3f25daf1f0)]:
  - @ocoda/event-sourcing@1.1.2

## 1.1.1

### Patch Changes

- [#384](https://github.com/ocoda/event-sourcing/pull/384) [`9f9af0e`](https://github.com/ocoda/event-sourcing/commit/9f9af0e3bfa36239121886635013ca515f38b09f) Thanks [@renovate](https://github.com/apps/renovate)! - Update dependencies

- Updated dependencies [[`9f9af0e`](https://github.com/ocoda/event-sourcing/commit/9f9af0e3bfa36239121886635013ca515f38b09f)]:
  - @ocoda/event-sourcing@1.1.1

## 1.1.0.0.0

### Minor Changes

- [#371](https://github.com/ocoda/event-sourcing/pull/371) [`eff4abd`](https://github.com/ocoda/event-sourcing/commit/eff4abda2b44a7fbcb1be7bccde7fc9267e7fded) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Support for a getAllEnvelopes method on the EventStore

### Patch Changes

- Updated dependencies [[`eff4abd`](https://github.com/ocoda/event-sourcing/commit/eff4abda2b44a7fbcb1be7bccde7fc9267e7fded)]:
  - @ocoda/event-sourcing@1.1.0

## 1.0.2

### Patch Changes

- [#361](https://github.com/ocoda/event-sourcing/pull/361) [`5be1d42`](https://github.com/ocoda/event-sourcing/commit/5be1d42d1eb0a19a252d2127b72a756b3cd701f6) Thanks [@renovate](https://github.com/apps/renovate)! - Dependency updates

- Updated dependencies [[`5be1d42`](https://github.com/ocoda/event-sourcing/commit/5be1d42d1eb0a19a252d2127b72a756b3cd701f6)]:
  - @ocoda/event-sourcing@1.0.2

## 1.0.1

### Patch Changes

- [#362](https://github.com/ocoda/event-sourcing/pull/362) [`8081e16`](https://github.com/ocoda/event-sourcing/commit/8081e16d3edcab21efa301a7e1261cfd062ab4e7) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Introduce ULID based event-ids and make sure these are persisted/retrieved correctly within the integrations

- [#362](https://github.com/ocoda/event-sourcing/pull/362) [`94e41eb`](https://github.com/ocoda/event-sourcing/commit/94e41ebea9a5d3762d39db0a3afb664bc0d78010) Thanks [@drieshooghe](https://github.com/drieshooghe)! - Adds a `listCollections` method to all integrations

- Updated dependencies [[`8081e16`](https://github.com/ocoda/event-sourcing/commit/8081e16d3edcab21efa301a7e1261cfd062ab4e7), [`94e41eb`](https://github.com/ocoda/event-sourcing/commit/94e41ebea9a5d3762d39db0a3afb664bc0d78010)]:
  - @ocoda/event-sourcing@1.0.1

## 1.0.0

### Major Changes

- This marks the first stable release of the library, which consists of the following changes:

  - all database-specific libraries have been migrated to their own libraries to reduce the bundle size
  - the `SnapshotHandler` was renamed to `SnapshotRepository`
  - the `SnapshotRepository` was provided with additional methods for retrieving snapshots in bulk
  - the database drivers were optimized (e.g. by only fetching the needed fields)
  - the DynamoDB snapshot-store serialization was fixed

### Patch Changes

- Updated dependencies
  - @ocoda/event-sourcing@1.0.0
