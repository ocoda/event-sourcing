---
'@ocoda/event-sourcing-mariadb': patch
'@ocoda/event-sourcing-mongodb': patch
'@ocoda/event-sourcing-postgres': patch
---

**The stores report their failures with the new error fields of `@ocoda/event-sourcing` 4.0.**

- A version conflict carries the stream, the pool, the expected version and the version the stream was at. When the append lost a race on the unique (stream, version) key and the store can't read the current version, `actualVersion` is left out instead of reporting a guess.
- An `EventStorePersistenceException` says whether the events may have been stored. PostgreSQL reports `'unknown'` once it issued the insert (a failure to get a pooled connection for it included), unless the server rejected the statement (an error of severity `ERROR`, which rolls the insert back); MariaDB only when the commit failed; and MongoDB whenever the insert failed, because its multi-document insert isn't atomic. Every earlier failure, such as the version check, is `'not-persisted'`.
- MongoDB: when an append loses a race on the unique key after storing some of its events and those can't be removed again, the store now throws an `EventStorePersistenceException` with `outcome: 'unknown'` (the `cause` is an `AggregateError` with both errors) instead of a version conflict, which promises that nothing was stored.
- The driver error is the `cause` of the exception, and not-found exceptions name the pool they searched.
