---
'@ocoda/event-sourcing-mongodb': patch
---

**`globalOrder: 'gap-safe'` only on MongoDB.** `MongoDBEventStore` claimed `'gap-safe'` on every server that reports a replica set, including Amazon DocumentDB (always `rs0`) and Azure Cosmos DB for MongoDB (`globaldb`). It now reports `'best-effort'` on an engine that speaks the MongoDB protocol but is not MongoDB, whatever topology that engine reports, and logs one warning per process:

- **FerretDB:** `buildInfo` has a `ferretdb` field.
- **The DocumentDB gateway and Azure DocumentDB (vCore):** `hello` has an `internal` document.
- **Amazon DocumentDB:** `getEngineVersion` answers an `engineVersion`.
- **Azure Cosmos DB for MongoDB:** `getLastRequestStatistics` answers a `RequestCharge`.
- **Fallback:** without one of these signals, the host names of the managed services decide.

MongoDB answers the vendor commands with `CommandNotFound`. It is only asked them on a replica set with the vendor's name or a host of the vendor's, and only a reply with the vendor's field counts. A probe that fails counts as no signal. `connect()` now also sends `buildInfo`.

FerretDB and Azure Cosmos DB for MongoDB have no transaction that spans two collections, and an elastic Amazon DocumentDB cluster has none at all, so they also report `atomicAppend: false`. The append path still follows the topology.
