---
'@ocoda/event-sourcing': major
---

**Aggregates keep their events until they are stored, and ids keep their class.** This is the aggregate API of ADR 0001 §4. See the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#aggregates-and-ids).

- **`AggregateRoot` gets `committedVersion`, `getUncommittedEvents()` and `markCommitted()`.** `version` is `committedVersion` plus the number of uncommitted events. A repository appends `getUncommittedEvents()` with `expectedVersion: committedVersion`, then calls `markCommitted()`, so a failed append keeps the events and the save can be retried. Saving an unchanged aggregate appends nothing.
- **`commit()` is deprecated** and will be removed in 5.0. It still returns the events and marks them as committed, but it does so before they are appended, so they are lost when the append fails.
- **`applyEvent()` runs the event handler first**, then counts the event. A handler that throws now leaves the version and the uncommitted events unchanged; 3.x had already counted and recorded the event. A handler that reads `this.version` gets the version before its event, one less than in 3.x.
- **`loadFromHistory()`, `applyEvent(event, true)` and the `version` setter throw the new `UncommittedEventsException`** (`ES_UNCOMMITTED_EVENTS`) while the aggregate has uncommitted events, and leave it unchanged. `loadFromHistory()` also accepts an array of events.
- **`@Aggregate({ missingHandler: 'ignore' })`** applies events the aggregate has no `@EventHandler()` for. `'throw'`, the default, keeps throwing a `MissingEventHandlerException`.
- **`SnapshotRepository.save()` no longer rejects.** It logs a snapshot that can't be serialized or stored: a version conflict as a warning, anything else as an error. It reads the versions a save covers from `markCommitted()` (or `commit()`), so a save from version 9 to 11 with an interval of 10 takes a snapshot, and a save that committed nothing takes none, even at a multiple of the interval. While the aggregate has uncommitted events, it logs a warning and takes no snapshot: 3.x stored a snapshot ahead of the stored events, and every later save of the stream conflicted.
- **`generate()`, `from()` and `ULID.factory()` create an instance of the class they are called on**: `AccountId.generate()` returns an `AccountId` instead of a `UUID`, also when the factory is passed around, as in `values.map(AccountId.from)`. **Ids of different classes are never equal**, even with the same value. `InvalidIdException.idType` names the class the value was given to (`'AccountId'` instead of `'UUID'`).
- **`ULID.from()` validates Crockford's base32**: 26 characters without I, L, O and U, in either case, starting with 0 to 7. 3.x accepted any 26 letters and digits. Event ids read from a store are not validated, so stored events stay readable.
- **`ulidFactory` is deprecated**: it has always been a no-op. Use `ULID.factory()`. Removed in 5.0.
- **`ValueObject.equals()` is null-safe**: it returns `false` for `null` and `undefined` instead of throwing, and compares the keys of the props, not only their number.

**Migration**

1. Save aggregates in three steps:

   ```ts
   // 3.x
   const events = account.commit();
   await this.eventStore.appendEvents(stream, account.version, events, pool);
   // 4.0
   const events = account.getUncommittedEvents();
   await this.eventStore.appendEvents(stream, events, { expectedVersion: account.committedVersion, pool });
   account.markCommitted(events);
   ```

   Call `markCommitted()` before `snapshotRepository.save()`, and load an aggregate (`loadFromHistory()`, or the `version` of a snapshot) before you apply new events to it.
2. Where a handler reads `this.version`, add one to get the version of its event, as in 3.x.
3. Where you compared ids of different classes with `equals()`, compare their `value`s. Where you matched `InvalidIdException.idType` against `'UUID'` or `'ULID'`, expect the name of your id class.
4. `generate()`, `from()` and `ULID.factory()` call `new this(value)`. An id class whose constructor takes anything other than the id alone must declare its own `generate()`, `from()` and `factory()`. TypeScript doesn't catch this when the first parameter is a string: `from()` then passes your value to that parameter and returns an id with a different value. Make a `private` constructor `protected`, or the inherited factories no longer compile.
5. If you relied on `SnapshotRepository.save()` rejecting, watch the logs instead, and call it after `markCommitted()`.
