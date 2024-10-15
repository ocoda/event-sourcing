# @ocoda/event-sourcing-postgres

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
