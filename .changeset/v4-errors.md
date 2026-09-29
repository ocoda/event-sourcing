---
'@ocoda/event-sourcing': major
---

**Every error the library throws now has a stable `code`, the fields that describe it and the original error as its `cause`.** Match errors on their code instead of their message or constructor.

- **`EventSourcingError` and `isEventSourcingError()`.** All library exceptions extend the new abstract `EventSourcingError` and keep their class names, so `instanceof` checks keep working. Each has a literal `name` that survives minification and a unique `code` from the new `EventSourcingErrorCode` object (for example `EventSourcingErrorCode.EventStoreVersionConflict`, `'ES_EVENT_STORE_VERSION_CONFLICT'`). `isEventSourcingError(error, code?)` narrows an unknown error and also recognises errors from a second copy of the package.
- **Errors say what went wrong in their fields.** `EventStoreVersionConflictException` has `streamId`, `aggregateId`, `pool`, `expectedVersion` (the version the stream had to have before the append) and `actualVersion` (left out when the append lost a race on the unique key). `EventStorePersistenceException` has `collection` and an `outcome`: `'not-persisted'` when nothing was written, `'unknown'` when the events may have been stored. Retrying with the same expected version is safe in both cases, because a duplicate append conflicts. The not-found and metadata exceptions name the class or stream they concern (`commandName`, `queryName`, `eventName`, `streamId`, `version`, ...), and `CommandHandlerNotFoundException` now names the command class instead of an internal id.
- **The stack is kept.** Wrapping exceptions used to replace their own stack with the stack of the driver error. The driver error is now the standard `cause`, and the stack points at where the exception was thrown.
- **Messages changed**, for version conflicts in particular. Code that matches on `error.message` should match on `error.code` and the fields instead.
- **`UnsupportedOperationException` replaces `NotImplementedException`.** `SnapshotRepository.loadMany()` and `loadAll()` threw the `NotImplementedException` of `@nestjs/common` when the snapshot store lacks `getManyLastSnapshotEnvelopes` or `getLastEnvelopesForAggregate`. They now throw `UnsupportedOperationException`, with the method name in `operation`. That class was never exported by this package, so there is no alias. An HTTP exception filter that relied on the 501 status of the Nest exception should map the new code instead.
- **`DomainException` gets a `name` and a `cause`.** Its `name` is the class name of your subclass, and its constructor takes the standard error options as a third argument: `super(message, id, { cause })`. It has no `code`, so existing subclasses compile unchanged. `InvalidIdException` still extends `DomainException`, and is also an `EventSourcingError` with a code.
- **Exceptions take one object argument.** Every exported exception is constructed with a single, null-safe details object, plus the standard error options for the `cause`. The static factories `InvalidIdException.becauseInvalid()`, `becauseEmpty()` and `because()`, `IdNotFoundException.withId()`, `IdAlreadyRegisteredException.withId()`, `InvalidAggregateStreamNameException.becauseExceedsMaxLength()` and `InvalidEventStreamNameException.becauseExceedsMaxLength()` still work, but are deprecated and will be removed in 5.0.
- **`ExpectedVersion`** is a new export: `ExpectedVersion.NoStream` (0) and `ExpectedVersion.Any`, and the `ExpectedVersion` type of `expectedVersion`.

**Migration**

1. Match errors on their code and fields rather than their message or constructor:

   ```ts
   // 3.x
   if (error instanceof EventStoreVersionConflictException && error.message.includes('latest is')) { … }
   if (error.constructor === EventStoreVersionConflictException) { … }
   // 4.0
   if (isEventSourcingError(error, EventSourcingErrorCode.EventStoreVersionConflict)) {
   	console.log(error.streamId, error.expectedVersion, error.actualVersion);
   }
   ```

2. Code that constructs library exceptions, such as a custom event or snapshot store, passes one object and puts the underlying error in the options:

   ```ts
   // 3.x
   throw new EventStoreVersionConflictException(stream, aggregateVersion, currentVersion, error);
   throw new EventStorePersistenceException(collection, error);
   throw new EventNotFoundException(stream.streamId, version);
   // 4.0
   throw new EventStoreVersionConflictException(
   	{ stream, expectedVersion: aggregateVersion - events.length, actualVersion: currentVersion, pool },
   	{ cause: error },
   );
   throw new EventStorePersistenceException({ collection, outcome: 'unknown' }, { cause: error });
   throw new EventNotFoundException({ streamId: stream.streamId, version, pool });
   ```

3. Replace `NotImplementedException` from `@nestjs/common` with `UnsupportedOperationException` (or `EventSourcingErrorCode.UnsupportedOperation`) where you catch the errors of `SnapshotRepository.loadMany()` and `loadAll()`.
4. Read the underlying error of a wrapping exception from `error.cause` instead of from its stack.
