<p align="center">
  <a href="http://ocoda.io/" target="blank"><img src="https://github.com/ocoda/.github/raw/master/assets/ocoda_logo_full_gradient.svg" width="600" alt="Ocoda Logo" /></a>
</p>

<p align="center">
  <a href="https://dl.circleci.com/status-badge/redirect/gh/ocoda/event-sourcing/tree/master">
    <img src="https://dl.circleci.com/status-badge/img/gh/ocoda/event-sourcing/tree/master.svg?style=shield">
  </a>
  <a href="https://codecov.io/gh/ocoda/event-sourcing">
    <img src="https://codecov.io/gh/ocoda/event-sourcing/branch/master/graph/badge.svg?token=D6BRXUY0J8">
  </a>
  <a href="https://github.com/ocoda/event-sourcing/blob/master/LICENSE.md">
    <img src="https://img.shields.io/badge/License-MIT-green.svg">
  </a>
</p>

&nbsp;
> &nbsp;
> This library is still under construction and thus subject to breaking changes. It's not recommended to use it in production. 🚧
> &nbsp;

This library was created to help people get started with event-sourcing in NestJS. Event-sourcing is the practice of capturing state **transitions** in your domain models instead of only capturing the current state. It contains the building blocks to implement Command query responsibility segregation, store events and snapshots, react to events and much more.

&nbsp;
<details open>
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#getting-started">Getting started</a></li>
    <li><a href="#aggregates--value-objects">Aggregates & value objects</a></li>
    <li><a href="#commands--command-handlers">Commands & command handlers</a></li>
    <li>
    <a href="#events">Events</a>
    <ul>
          <li><a href="#event-streams">Event streams</a></li>
          <li><a href="#event-store">Event store</a></li>
      <li><a href="#event-listeners">Event listeners</a></li>
      </ul>
  </li>
  <li>
    <a href="#snapshots">Snapshots</a>
    <ul>
          <li><a href="#snapshot-streams">Snapshot streams</a></li>
          <li><a href="#snapshot-store">Snapshot store</a></li>
      </ul>
  </li>
  <li><a href="#aggregate-repositories">Aggregate repositories</a></li>
    <li><a href="#queries">Queries</a></li>
    <li><a href="#misc">Misc</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>
&nbsp;
<hr/>
&nbsp;

## Getting started
To get started with this library, you need to install it first.
```
npm install @ocoda/event-sourcing
```
This library currently provides wrappers for storing events and snapshots for MongoDB and DynamoDB. To make use of database wrappers, you will need to install their respective libraries:
```
npm install mongodb # For using MongoDB
npm install @aws-sdk/client-dynamodb @aws-sdk/util-dynamodb # For using DynamoDB
```
For testing purposes no database wrapper is required, this library ships with a fully functional in-memory store.

Once you have installed all required packages we can import the EventSourcingModule into the root AppModule of your application. The configuration itself depends on the type of database you want to use and if you want to make use of snapshots.
```typescript
import { EventSourcingModule } from '@ocoda/event-sourcing';
import { Events } from './app.providers.ts';

@Module({
  imports: [
    EventSourcingModule.forRoot({
      eventStore: {
        client: 'mongodb',
        options: { 
          url: 'mongodb://127.0.0.1:27017' 
        },
      },
      snapshotStore: {
        client: 'dynamodb',
        options: {
          region: 'us-east-1',
          credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
        }
      },
      events: [...Events],
    }),
})
export class AppModule {}
```
&nbsp;

## Aggregates & value objects
An aggregate models an individual concept that has a unique identity in your application, e.g. an account.

To create an aggregate using this library you will need to:
- inherit the `AggregateRoot` class, which is responsible for handling events and keeping track of the version of the aggregate
- apply the `@Aggregate()` decorator

```typescript
import { Aggregate, AggregateRoot } from '@ocoda/event-sourcing';

@Aggregate('account')
class Account extends AggregateRoot {
  ...
}
```

The `@Aggregate()` decorator marks the class as an aggregate and optionally specifies how the streamId of events and snapshots should be named, e.g. `@Aggregate({ streamName: 'account' })` will create the following streamId: `account-d46fb0f9-02dc-4d11-a282-ab00f7fffeff`. If the stream name isn't provided in the decorator, the name of the class will automatically be converted to lowercase and used.

A Value Object is an immutable model has no conceptual identity, it describes charasteristics and optionally requires some validation, e.g. the name of an account. To create a value object, we can simply extend the ValueObject class.

```typescript
import { ValueObject } from '@ocoda/event-sourcing';

export class AccountName extends ValueObject {
  public static fromString(name: string) {
    if(name.length < 3) {
      throw new Error('Account name should contain at least 3 characters');
    }
    return new Accountname({ value: name });
  }

  get value(): string {
    return this.props.value;
  }
}
```
&nbsp;

## Commands & command handlers
A Command is an object that is sent to your domain application that describes the intent of the user and is handled by a CommandHandler. Ideally the name of a command implies the Aggregate it operates on and its intent imperatively, e.g. OpenAccountCommand.

```typescript
import { ICommand } from '@ocoda/event-sourcing';

class OpenAccountCommand implements ICommand {
  constructor(public readonly accountOwner: string) {}
}
```

You can then define a CommandHandler that will be responsible for handling every execution of this Command.

```typescript
import { CommandHandler, ICommandHandler } from '@ocoda/event-sourcing';

@CommandHandler(OpenAccountCommand)
export class OpenAccountCommandHandler implements ICommandHandler {

  constructor(private readonly accountRepository: AccountRepository) {}

  async execute(command: OpenAccountCommand): Promise<string> {
    const accountId = AccountId.generate();
    const account = Account.open(accountId, command.accountOwnerIds?.map(AccountOwnerId.from));

    await this.accountRepository.save(account);

    return accountId.value;
  }
}
```

Don't forget to register your CommandHandlers as providers in your application.
&nbsp;

## Events
Events are classes that describe a fact that took place. They can be created by using the `@Event()` decorator and must be registered in the EventSourcingModule. If no name is explicitly provided, the name of the class itself is used, otherwise the provided name gets added as metadata to your class. The name of your event is used internally to create a map of the events within your application and optionally link that event to a custom event serializer.

```typescript
@Event('account-opened')
export class AccountOpenedEvent implements IEvent {
  constructor(
    public readonly accountId: string,
    public readonly openedOn: string,
    public readonly accountOwnerIds?: string[]
  ) {}
}
```

Preferrably events contain only primitive values, otherwise this can cause issues when storing and reading them from a database. To mediate this however, whenever an event needs to be stored or retrieved from the database it gets (de)serialized using the [class-transformer](https://github.com/typestack/class-transformer) library, you can however write your own serializer logic for an event. If you decide to, don't forget to register your event serializers as providers in your application.

```typescript
@Event('account-opened')
export class AccountOpenedEvent implements IEvent {
  constructor(
    public readonly accountId: AccountId,
    public readonly openedOn: Date,
    public readonly accountOwnerIds?: AccountOwnerId[]
  ) {}
}

@EventSerializer(AccountOpenedEvent)
export class AccountOpenedEventSerializer implements IEventSerializer {
  serialize({ accountId, openedOn, accountOwnerIds }: AccountOpenedEvent): IEventPayload<AccountOpenedEvent> {
    return {
      accountId: accountId.value,
      openedOn: openedOn.toISOString(),
      accountOwnerIds: accountOwnerIds?.map((id) => id.value)
    };
  }

  deserialize({ id, openedOn, accountOwnerIds }: IEventPayload<AccountOpenedEvent>): AccountOpenedEvent {
    const accountId = AccountId.from(id);
    const openedOnDate = openedOn && new Date(openedOn);
    const ownerIds = accountOwnerIds?.map((id) => AccountOwnerId.from(id));

    return new AccountOpenedEvent(accountId, openedOnDate, ownerIds);
  }
}
```
&nbsp;

### Event streams
The EventStream class creates a representation of a stream of events for a specific aggregate.

```typescript
const accountId = Id.generate();
const stream = EventStream.for(Account, accountId); 
// For a multi-tenant setup: EventStream.for(Account, accountId, pool);

stream.streamId; // account-af9a0775-b868-4063-89d8-ccc81bce3c3d
```
&nbsp;

### Event store
This library provides several types of event store implementations, as described above.
It's important to trigger the setup method on a store in order to prepare the database for storing your events, basically what this does is create an `events` or `snapshots` table or collection.
In a multi-tenant infrastructure, separate event-tables can be created by triggering the setup method with a "pool", which prefixes the table name with the tenant-pool you provided. This pool can then be passed to the event-store when writing or reading events/snapshots.

```typescript
import { EventStore } from '@ocoda/event-sourcing';

class AppModule implements OnModuleInit {

  constructor(private readonly eventStore: EventStore) {}

  async onModuleInit() {
    await this.eventStore.setup();
  }
}
```
&nbsp;

### Event envelopes
Events that get stored to a stream are always wrapped in an EventEnvelope. This envelope contains the name of the event as specified with the `@Event()` decorator, the serialized version of the event and additional metadata. (eventId, aggregateId, version, etc.)

### Event publishers
Whenever the EventStore appends events, the produced EventEnvelopes get published by the EventPublishers that are registered in the EventBus. A default EventPublisher takes care of publishing events internally, which allows us to create and register EventHandlers that automatically respond to these events.

```typescript
@EventHandler(AccountOpenedEvent)
export class AccountOpenedEventHandler implements IEventHandler {
	handle(envelope: EventEnvelope<AccountOpenedEvent>) {
		...
	}
}
```

To register an additional EventPublisher to push your EventEnvelopes to Redis, SNS, Kafka, etc. simply create one and register it as a provider.

```typescript
@EventPublisher()
export class CustomEventPublisher implements IEventPublisher {
	async publish(envelope: EventEnvelope<IEvent>): Promise<void> {
		...
	}
}
```

## Snapshots
Snapshots are an optimization that is completely optional. However, they come in handy when event-streams become large and reading them out becomes slow.
&nbsp;

### Snapshot streams
The SnapshotStream class creates a representation of a stream of snapshots for a specific aggregate.

```typescript
const accountId = Id.generate();
const stream = SnapshotStream.for(Account, accountId);

stream.streamId // account-af9a0775-b868-4063-89d8-ccc81bce3c3d
```
&nbsp;

### Snapshot store
 The SnapshotStore saves the state of an aggregate at a certain interval and only fetch the events from that version on. Just as the EventStore it needs to be setup, optionally with a tenant pool.
 Another advantage of using the snapshot handler is that it also creates a snapshot at version 1 of your aggregate, which makes it easier to get a complete set of aggregates of a certain type in your application.

```typescript
import { SnapshotStore } from '@ocoda/event-sourcing';

class AppModule implements OnModuleInit {

  constructor(private readonly snapshotStore: SnapshotStore) {}

  async onModuleInit() {
    await this.snapshotStore.setup();
  }
}
```
&nbsp;

### Snapshot handlers
The store is used behind the scenes of the SnapshotHandler base class, which is responsible for saving and loading snapshots behind the scenes.

How an aggregate snapshot is (de)serialized is the responsibility of a SnapshotHandler which extends the base and is decorated with the `@Snapshot()` decorator, which specifies:
- which aggregate it's responsible for
- the stream name (defaults to the name of the aggregate's class)
- at which interval a snapshot should be taken

```typescript
import { SnapshotHandler } from '@ocoda/event-sourcing';

@Snapshot(Account, { name: 'account', interval: 5 })
export class AccountSnapshotHandler extends SnapshotHandler<Account> {
  serialize({ id, ownerIds, balance, openedOn, closedOn }: Account) {
    return {
      id: id.value,
      ownerIds: ownerIds.map(({ value }) => value),
      balance,
      openedOn: openedOn ? openedOn.toISOString() : undefined,
      closedOn: closedOn ? closedOn.toISOString() : undefined,
    };
  }
  deserialize({ id, ownerIds, balance, openedOn, closedOn }: ISnapshot<Account>): Account {
    const account = new Account();
    account.id = AccountId.from(id);
    account.ownerIds = ownerIds.map(AccountOwnerId.from);
    account.balance = balance;
    account.openedOn = openedOn && new Date(openedOn);
    account.closedOn = closedOn && new Date(closedOn);

    return account;
  }
}
```
&nbsp;

## Aggregate repositories
Aggregate repositories are where both stores meet. For example:
```typescript
@Injectable()
export class AccountRepository {

  constructor(
    private readonly eventStore: EventStore,
    private readonly accountSnapshotHandler: AccountSnapshotHandler,
  ) {}

  async getById(accountId: AccountId) {
    const eventStream = EventStream.for<Account>(Account, accountId);

    const account = await this.accountSnapshotHandler.load(accountId);

    const events = this.eventStore.getEvents(eventStream, { fromVersion: account.version + 1 });

    await account.loadFromHistory(events);

    if (account.version < 1) {
        throw new AccountNotFoundException(accountId.value);
    }

    return account;
  }

  async save(account: Account): Promise<void> {
    const events = account.commit();
    const stream = EventStream.for<Account>(Account, account.id);

    await Promise.all([
      this.accountSnapshotHandler.save(account.id, account),
      this.eventStore.appendEvents(stream, account.version, events),
    ]);
  }
}
```
&nbsp;

## Queries
You can create queries to return the data you need.
```typescript
export class GetAccountQuery {

  constructor(public readonly accountId: string) {}

}

@QueryHandler(GetAccountQuery)
export class GetAccountQueryHandler implements IQueryHandler {

  constructor(private readonly accountRepository: AccountRepository) {}

  async execute(query: GetAccountQuery): Promise<Account> {
    const accountId = AccountId.from(query.accountId);
    const account = await this.accountRepository.getById(accountId);

    return account;
  }
}
```
&nbsp;

## Misc
- **What about materialized views?**
Event sourcing articles often suggest to listen to published events to create or update a database view that is optimized for reading. While this offers some advantages, there is a lot of overhead to consider when doing so. An alternative is to simply read out your write models. A very interesting read about the benefits and trade-offs can be found [here](https://www.eventstore.com/blog/live-projections-for-read-models-with-event-sourcing-and-cqrs).

- **What about sagas?**
At this point, I haven't created Sagas because in basic use cases EventHandlers can take care of triggering side-effects.
If the need arises, I'll look into this.
&nbsp;

## Contact
dries@drieshooghe.com
&nbsp;

## Acknowledgments
This library is inspired by [@nestjs/cqrs](https://github.com/nestjs/cqrs)