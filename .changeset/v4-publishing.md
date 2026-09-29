---
'@ocoda/event-sourcing': major
---

**The `EventBus` awaits asynchronous event publishers, reports every delivery failure on an observable, and drains the running publishers and subscribers when the application shuts down.** This is the 4.0 publishing pipeline of ADR 0001.

- **Publishers are awaited, in order.** Each publisher gets the envelopes of an append in commit order, one call at a time: the bus awaits the promise that `publish` returns before it passes the next envelope, and `appendEvents` resolves once every publisher is done. 3.x fired asynchronous publishers and forgot them. Each publisher also gets the appends of a stream one after the other, in the order in which they were stored, even when they run concurrently; appends to other streams don't wait for each other. The publishers run concurrently, so a slow publisher holds back neither the others nor the subscribers, but it now slows down the commands whose events it publishes.
- **Publisher timeout.** Each publisher call may take at most `publishing.publisherTimeout` milliseconds, 30 000 by default; `0` disables it. After that the bus logs the timeout, reports it and moves on to the next envelope. An append waits up to that timeout for each call, and for the calls of earlier appends to the same stream that a publisher still handles.
- **Publishers that publish.** A publisher that appends events or calls `eventBus.publish()` from inside its `publish` gets those envelopes at once instead of waiting for itself. The subscribers are fed after the other publishers, so what a subscriber appends to a stream in reaction to an event reaches the publishers after that event.
- **Batch publishers.** A publisher that implements `publishAll(envelopes)` gets the envelopes of an append in one call instead of one `publish` call each.
- **`eventBus.publish()` returns a promise** that resolves once the publishers are done. Like `publishAll()`, it never rejects. The envelopes of an append no longer go through `publish()`, so a spy on `eventBus.publish` sees nothing.
- **Delivery errors.** `eventBus.deliveryErrors$.subscribe(({ kind, handler, envelope, error }) => …)` gets every publisher or subscriber that throws, rejects or (publishers only) times out; a timeout is a `DOMException` named `TimeoutError`. The failures are still logged, and still never make an append fail.
- **`eventBus.whenIdle({ timeout })`** resolves once no publisher or subscriber is running. Without a timeout it waits as long as it takes; with one, it rejects with a `TimeoutError` when the bus is still busy after it.
- **Shutdown.** `app.close()` now waits, in `beforeApplicationShutdown`, for the publishers and subscribers that are still running, for at most `publishing.shutdownTimeout` milliseconds (10 000 by default, `0` waits as long as it takes). Then, in `onApplicationShutdown`, the bus unsubscribes the subscribers and the event and snapshot stores disconnect, once each. 3.x did both in `onModuleDestroy`, which dropped the deliveries in flight.
- **`IEventPublisher.publish`** returns `unknown` instead of `any` and no longer declares rest parameters, which the bus never passed. A publisher that returns its client's result keeps compiling; so does a `publishAll` that does. `IEventBus.publish` returns `Promise<void>`.
- **Invalid timeouts** (negative, `NaN`, not a number) fail the bootstrap with a `RangeError`.

**Migration**

1. In tests, wait for the subscribers with `await eventBus.whenIdle()` instead of a fixed delay:

   ```ts
   // 3.x
   await commandBus.execute(command);
   await new Promise((resolve) => setTimeout(resolve, 50));
   // 4.0
   await commandBus.execute(command);
   await eventBus.whenIdle();
   ```

2. Replace spies on `eventBus.publish` with a publisher of your own or a subscription to the bus, and `await eventBus.publish(envelope)` where you publish directly.
3. If a publisher can take longer than 30 s, raise `publishing.publisherTimeout`, or set it to `0`, in `forRoot` or in the options of `forRootAsync`:

   ```ts
   EventSourcingModule.forRoot({ events, publishing: { publisherTimeout: 60_000, shutdownTimeout: 15_000 } });
   ```

4. If your subscribers use providers that clean up in `onModuleDestroy`, which NestJS runs before the bus drains, call `await eventBus.whenIdle()` before `app.close()`.
