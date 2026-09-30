---
'@ocoda/event-sourcing': major
---

**Event handlers can apply events, and `markCommitted(events)` marks only the events that were appended.** This settles the aggregate questions that the 4.0 aggregate API left open. See the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#aggregates-and-ids) and [Event handlers that apply events](https://ocoda.github.io/event-sourcing/start/aggregates#event-handlers-that-apply-events).

- **An event that an `@EventHandler()` applies is applied once that handler returns**, right after the handler's own event. The events keep the order and the versions that 3.x recorded: an event that a handler applies follows the handler's event, and the events that its own handler applies follow it. What changes is when its handler runs: 3.x ran it in the middle of the handler that applied the event.
- **While an aggregate is loaded from its events, the `applyEvent()` calls of its handlers are ignored**, because the stored events already include the events they applied. 3.x applied such an event a second time on every load, counted it twice and recorded it as uncommitted, so the next save stored it again. Streams that 3.x wrote this way now load as they were written.
- **When an event handler throws, the events it applied are dropped.** The events whose handlers returned stay applied.
- **`markCommitted(events)`** marks the events that `getUncommittedEvents()` returned as committed, once they are appended, and keeps the events applied in the meantime, for example while the append ran, for the next save. Events that aren't the first uncommitted events, in order, throw an `UncommittedEventsException` with `operation: 'markCommitted'`, and the aggregate stays unchanged. `markCommitted()` without arguments still marks every uncommitted event as committed, also one that was applied while the append ran and was never stored.

**Migration**

1. Pass the appended events to `markCommitted()`:

   ```ts
   const events = account.getUncommittedEvents();
   await this.eventStore.appendEvents(stream, events, { expectedVersion: account.committedVersion, pool });
   account.markCommitted(events);
   ```

2. Where an event handler applies an event and then reads state that the handler of that event changes, move that code into the handler of the applied event: it now runs after the handler that applied the event, as it does when the aggregate is loaded.
