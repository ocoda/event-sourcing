---
'@ocoda/event-sourcing-mariadb': patch
'@ocoda/event-sourcing-mongodb': patch
'@ocoda/event-sourcing-postgres': patch
---

**The stores report their failures with the new error fields of `@ocoda/event-sourcing` 4.0.**

- A version conflict carries the stream, the pool, the expected version and the version the stream was at. When the append lost a race on the unique (stream, version) key and the store can't read the current version, `actualVersion` is left out instead of reporting a guess.
- An `EventStorePersistenceException` says whether the events may have been stored. PostgreSQL reports `'unknown'` only when the connection failed while the insert was in flight, MariaDB only when the commit failed, and MongoDB whenever the insert failed, because its multi-document insert isn't atomic. Every other failure is `'not-persisted'`.
- The driver error is the `cause` of the exception, and not-found exceptions name the pool they searched.
