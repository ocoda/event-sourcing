---
'@ocoda/event-sourcing': major
---

**The event store contract is final.** Every store now runs the appends and event reads of the `EventStore` base class, and the 3.x ways of reading all events are gone. See the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#read-all) and [Migrating a 3.x store](https://ocoda.github.io/event-sourcing/advanced/custom-stores#migrating-a-3x-store).

- **`getAllEnvelopes`, `IAllEventsFilter`, `EventStore.getYearMonthRange` and `ULID.yearMonth` are removed.** Read a pool with `readAll({ fromPosition, batch, pool })`, and filter on `metadata.occurredOn` to read a period. For `ULID.yearMonth`, also on `EventId`, use `id.date.toISOString().slice(0, 7)`.
- **A store that overrides `appendEvents`, `getEvent` or `getEvents` fails the bootstrap** with an `InvalidEventStoreImplementationException`, also when it overrides `appendEvents` the 3.x way. `this.eventMap` is removed too: the base class serializes and deserializes the events. Implement the driver methods instead; to decorate the appends of a store you extend, override its `persistEvents`.
- **`getStreamVersion`, `readAll` and `persistEvents` are abstract**, like the other driver methods, so TypeScript reports a custom store that lacks one.
- **`appendEvents` is declared as two overloads**: the options form, and the deprecated positional form, which keeps working until 5.0.
