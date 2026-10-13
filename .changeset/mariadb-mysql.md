---
'@ocoda/event-sourcing-mariadb': minor
---

**MySQL support.** `MariaDBEventStore` and `MariaDBSnapshotStore` now run on MySQL 8.4 LTS, 9.7 LTS and the newest Innovation release (26.7), on the same `mariadb` connector, and CI tests every release. On a single MySQL server, or the primary of a replica set, the event store keeps `globalOrder: 'gap-safe'`: appends take their positions from the pool's counter row, so they commit in position order, as on MariaDB.

- **Connecting.** MySQL authenticates with `caching_sha2_password`. Over plain TCP, the connector then needs `allowPublicKeyRetrieval: true` or the server's key (`cachingRsaPublicKey`). With TLS it needs neither.
- **JSON on MySQL.** New MySQL tables store `payload` and `headers` as `LONGTEXT`, the text `JSON.stringify` wrote. MySQL's `JSON` type sorts the keys of objects and prints doubles with 16 significant digits, so `0.9999999999999999` would come back as `1`. MariaDB tables keep `JSON`, MariaDB's alias of `LONGTEXT`. The stores read both column types.
- **`migrate()` is MariaDB only.** On MySQL, `MariaDBEventStore.migrate()` and `MariaDBSnapshotStore.migrate()` throw an `UnsupportedOperationException` before they change anything.
- **No more deprecated syntax.** The stores no longer use `VALUES()` in `ON DUPLICATE KEY UPDATE`, or the `BINARY` operator, which MySQL deprecates. Inspecting a table with a functional index (MySQL) no longer throws.
