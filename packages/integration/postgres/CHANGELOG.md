# @ocoda/event-sourcing-postgres

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
