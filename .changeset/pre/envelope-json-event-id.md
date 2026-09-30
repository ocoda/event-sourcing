---
'@ocoda/event-sourcing': major
---

**`JSON.stringify(envelope)` writes the event id as a string.** `EventEnvelope.toJSON()` renders `metadata.eventId` as its value, such as `"01JA50F56AM0CCDBNVQW3TTWNY"`, where 3.x wrote the value object as `{ "props": { "value": "01JA50F56AM0CCDBNVQW3TTWNY" } }`. A publisher or an API that sends envelopes as JSON now sends the id itself: a consumer that read `metadata.eventId.props.value` reads `metadata.eventId`, and `EventId.from(json.metadata.eventId)` turns it back into an `EventId`. The rest of the metadata is written as before, with `occurredOn` as an ISO 8601 string; the new global position is a decimal string.

What the stores write doesn't change. Value objects get no `toJSON`, so `JSON.stringify(id)` still writes `{ props: { value } }`, and so do the PostgreSQL and MariaDB stores for a value object in a snapshot or in the payload of a custom serializer. The payload in the JSON of an envelope is rendered the same way, as it is stored.
