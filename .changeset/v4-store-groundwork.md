---
'@ocoda/event-sourcing': minor
---

**Groundwork for the 4.0 event store contract.** The additions that the store contract, in its own entry of this release, builds on.

- **`EventEnvelope.create` keeps the generated event id when `eventId` is `undefined`.** Passing `eventId: undefined` explicitly used to replace the generated id with `undefined`. `create` also takes an optional `occurredOn`, which still defaults to the time of the event id.
- **`EventEnvelope.toJSON()`.** `JSON.stringify(envelope)` writes a bigint, such as the upcoming global position, as a decimal string instead of throwing. It also writes the event id as a string, see its own entry of this release.
- **Envelope metadata** has three new optional fields: `headers`, `eventVersion` and `globalPosition` (a bigint).
- **New exceptions, each with its own code:** `InvalidEventEnvelopeException` (`ES_INVALID_EVENT_ENVELOPE`), `InvalidEventMetadataException` (`ES_INVALID_EVENT_METADATA`), `InvalidAppendOptionsException` (`ES_INVALID_APPEND_OPTIONS`), `EventCollectionNotFoundException` (`ES_EVENT_COLLECTION_NOT_FOUND`), `InvalidEventStoreImplementationException` (`ES_INVALID_EVENT_STORE_IMPLEMENTATION`) and `EventStoreSchemaException` (`ES_EVENT_STORE_SCHEMA`).
- **Types** for the append options (`AppendOptions`, `AppendMetadata`, `EventHeaders`), the capabilities of a store (`EventStoreCapabilities`), what a store is constructed with (`EventStoreContext`, `EnvelopePublisher`), the result of a write (`PersistOutcome`, `PersistTarget`), reading a whole pool (`IReadAllFilter`) and schema migrations (`MigrationOptions`, `MigrationReport`, `SchemaOptions`).
- **Helpers for store implementations:**
  - `toPosition()` converts a global position as a database driver returns it (a decimal string, a number, a bigint or an Int64 object) to a bigint, and rejects anything that isn't a non-negative integer.
  - `resolveCapabilities()` fills in the capabilities a store leaves out with `DEFAULT_EVENT_STORE_CAPABILITIES`.
  - `EVENT_STORE_LIMITS`: at most 255 characters for stream ids, aggregate ids, event names, correlation ids and causation ids, and 8 KiB for the headers of an event.
  - `EventId.fromTrusted()` wraps an event id read from a store without validating it, so that stored events stay readable if id validation gets stricter.
  - `ANY_MAX_ATTEMPTS`, how often an append with `ExpectedVersion.Any` will be tried.
- **`EventBus.publishAll(envelopes)`** publishes the envelopes of an append in order. The publishing entry of this release describes how it awaits the publishers.
