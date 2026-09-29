---
'@ocoda/event-sourcing': major
---

**A JSON serializer replaces class-transformer as the default event serializer.** `JsonEventSerializer` serializes every event that has no `@EventSerializer()` of its own. It needs no decorators and no dependency, and for events without class-transformer decorators it stores the same payloads and reads back the same events as 3.x, so stored events need no migration. See [Event Serialization](https://ocoda.github.io/event-sourcing/advanced/event-serialization) and the [4.0 migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4#serialization).

- **Same results as 3.x.** Nested class instances, value objects such as ids included, are stored as plain objects (`{ props: { value } }`) and read back as plain objects. A `Date` stays a `Date` in the payload: the SQL stores write an ISO string and read that string back, MongoDB stores a date. A `Set` becomes an array and a `Map` an object; getters and `toJSON` on the prototype are ignored. Deserializing calls the constructor without arguments, so its defaults fill the fields that older payloads lack, and it skips `__proto__`, `constructor`, methods and getters without a setter.
- **Events with class-transformer decorators fail the bootstrap.** An event with `@Type`, `@Transform`, `@Expose` or `@Exclude` that would get the JSON serializer throws an `EventSerializationException` (`reason: 'class-transformer-decorators'`) that names the event, its decorators and the fix, instead of losing their effect silently. The check finds decorators applied through class-transformer's CommonJS build, which Node loads; a bundler that resolves its ES module build keeps a second copy of the metadata, which the check can't see.
- **`ClassTransformerEventSerializer`**, from the new entry point `@ocoda/event-sourcing/class-transformer`, serializes with class-transformer as 3.x did. Use it for every event with `EventSourcingModule.forRoot({ defaultEventSerializer: ClassTransformerEventSerializer })` (`forRootAsync` too), or for one event with `ClassTransformerEventSerializer.for(MyEvent)`. `defaultEventSerializer` takes any `EventSerializerFactory`, an object with a `for(event)` method.
- **class-transformer is an optional peer dependency** (`^0.5.1`) instead of a dependency. Install it if you use `ClassTransformerEventSerializer` or class-transformer's decorators.
- **`DefaultEventSerializer` is removed** from `@ocoda/event-sourcing`, so code that used it chooses a serializer: `JsonEventSerializer` or `ClassTransformerEventSerializer`.
- **A circular reference in an event** fails the append with an `EventSerializationException` (`reason: 'circular-reference'`, with the `path` of the reference) before anything is written. 3.x overflowed the stack.
- `EventSerializationException` has the code `ES_EVENT_SERIALIZATION`. `EventMap.registerSerializers()` takes an options object as its third argument.

**Migration**

1. Replace `DefaultEventSerializer.for(MyEvent)` with `JsonEventSerializer.for(MyEvent)`, or with `ClassTransformerEventSerializer.for(MyEvent)` for an event with class-transformer decorators.
2. If your events use class-transformer decorators, install `class-transformer@^0.5.1` and set `defaultEventSerializer: ClassTransformerEventSerializer`, or give those events an `@EventSerializer()` of their own. Then bootstrap the application: it fails as long as an event with decorators is left on the JSON serializer, and names it.
3. If you bundle the application, check your events for class-transformer decorators yourself: the bootstrap check may not see them.
