// A small NestJS 12 application that consumes the packed @ocoda/event-sourcing tarballs. scripts/test-consumers.mjs
// compiles it twice: as ESM ("type": "module") and as CommonJS, where tsc emits require() calls that load the
// ESM-only packages through require(esm). It boots EventSourcingModule with forRoot and with forRootAsync, next to a
// forFeature module, on the in-memory stores, runs a command, a query and a round trip through the event store, loads
// @ocoda/event-sourcing/testing outside a test runner, and exits 0 only if every check passed.
import 'reflect-metadata';
import { type DynamicModule, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
	Aggregate,
	AggregateRoot,
	CommandBus,
	CommandHandler,
	Event,
	EventBus,
	type EventDeliveryError,
	type EventEnvelope,
	EventHandler,
	EventSourcingConfigurationException,
	EventSourcingModule,
	EventStore,
	EventStoreVersionConflictException,
	EventStream,
	EventSubscriber,
	type ICommand,
	type ICommandHandler,
	type IEvent,
	type IEventSubscriber,
	type IQuery,
	type IQueryHandler,
	type ISnapshot,
	QueryBus,
	QueryHandler,
	Snapshot,
	SnapshotRepository,
	SnapshotStore,
	UUID,
} from '@ocoda/event-sourcing';
import { MariaDBEventStore, MariaDBSnapshotStore } from '@ocoda/event-sourcing-mariadb';
import { MongoDBEventStore, MongoDBSnapshotStore } from '@ocoda/event-sourcing-mongodb';
import { PostgresEventStore, PostgresSnapshotStore } from '@ocoda/event-sourcing-postgres';
import { ClassTransformerEventSerializer } from '@ocoda/event-sourcing/class-transformer';
import {
	EVENT_STORE_CONFORMANCE_CASES,
	RecordingPublisher,
	createInMemoryEventStore,
	createInMemorySnapshotStore,
} from '@ocoda/event-sourcing/testing';
import { Type } from 'class-transformer';

const format = typeof require === 'function' ? 'cjs' : 'esm';
let failures = 0;

function check(ok: boolean, label: string): void {
	console.log(`${ok ? 'PASS' : 'FAIL'}  [${format}] ${label}`);
	if (!ok) failures++;
}

// Fail instead of hanging if a store or the application never settles.
setTimeout(() => {
	console.log(`FAIL  [${format}] timed out`);
	process.exit(1);
}, 30_000).unref();

// ---- domain ---------------------------------------------------------------------------------------------------------

class AccountId extends UUID {}

@Event('consumer-account-opened')
class AccountOpenedEvent implements IEvent {
	constructor(public readonly accountId: string) {}
}

@Event('consumer-account-credited')
class AccountCreditedEvent implements IEvent {
	constructor(public readonly amount: number) {}
}

class Money {
	constructor(
		public readonly amount: number,
		public readonly currency: string,
	) {}
}

/** Read back as a `Money` only by class-transformer, through `@Type`. */
@Event('consumer-funds-deposited')
class FundsDepositedEvent implements IEvent {
	@Type(() => Money)
	readonly amount: Money;

	constructor(amount: Money) {
		this.amount = amount;
	}
}

@Aggregate({ streamName: 'consumer-account' })
class Account extends AggregateRoot {
	id!: AccountId;
	balance = 0;

	static open(id: AccountId): Account {
		const account = new Account();
		account.applyEvent(new AccountOpenedEvent(id.value));
		return account;
	}

	credit(amount: number): void {
		this.applyEvent(new AccountCreditedEvent(amount));
	}

	@EventHandler(AccountOpenedEvent)
	onOpened(event: AccountOpenedEvent): void {
		this.id = AccountId.from(event.accountId);
	}

	@EventHandler(AccountCreditedEvent)
	onCredited(event: AccountCreditedEvent): void {
		this.balance += event.amount;
	}
}

@Snapshot(Account, { name: 'consumer-account', interval: 2 })
class AccountSnapshotRepository extends SnapshotRepository<Account> {
	serialize({ id, balance }: Account): ISnapshot<Account> {
		return { id: id.value, balance };
	}

	deserialize({ id, balance }: ISnapshot<Account>): Account {
		const account = new Account();
		account.id = AccountId.from(id);
		account.balance = balance;
		return account;
	}
}

// ---- application ----------------------------------------------------------------------------------------------------

@Injectable()
class AccountRepository {
	// Both parameters are resolved by type, so this only works if the decorator metadata survived.
	constructor(
		private readonly eventStore: EventStore,
		private readonly snapshots: AccountSnapshotRepository,
	) {}

	async getById(id: AccountId): Promise<Account> {
		const account = await this.snapshots.load(id);
		await account.loadFromHistory(
			this.eventStore.getEvents(EventStream.for<Account>(Account, id), { fromVersion: account.version + 1 }),
		);
		return account;
	}

	async save(account: Account): Promise<void> {
		const events = account.commit();
		await this.eventStore.appendEvents(EventStream.for<Account>(Account, account.id), account.version, events);
		await this.snapshots.save(account.id, account);
	}
}

class OpenAccountCommand implements ICommand {}

@CommandHandler(OpenAccountCommand)
class OpenAccountCommandHandler implements ICommandHandler {
	constructor(private readonly accounts: AccountRepository) {}

	async execute(): Promise<string> {
		const account = Account.open(AccountId.generate());
		await this.accounts.save(account);
		return account.id.value;
	}
}

class CreditAccountCommand implements ICommand {
	constructor(
		public readonly accountId: string,
		public readonly amounts: number[],
	) {}
}

@CommandHandler(CreditAccountCommand)
class CreditAccountCommandHandler implements ICommandHandler {
	constructor(private readonly accounts: AccountRepository) {}

	async execute({ accountId, amounts }: CreditAccountCommand): Promise<void> {
		const account = await this.accounts.getById(AccountId.from(accountId));
		for (const amount of amounts) account.credit(amount);
		await this.accounts.save(account);
	}
}

class GetAccountQuery implements IQuery {
	constructor(public readonly accountId: string) {}
}

@QueryHandler(GetAccountQuery)
class GetAccountQueryHandler implements IQueryHandler<GetAccountQuery, { balance: number; version: number }> {
	constructor(private readonly accounts: AccountRepository) {}

	async execute({ accountId }: GetAccountQuery): Promise<{ balance: number; version: number }> {
		const { balance, version } = await this.accounts.getById(AccountId.from(accountId));
		return { balance, version };
	}
}

const received: string[] = [];

@EventSubscriber(AccountOpenedEvent, AccountCreditedEvent)
class RecordingSubscriber implements IEventSubscriber {
	handle({ event }: EventEnvelope): void {
		received.push(event);
	}
}

@Module({
	imports: [EventSourcingModule.forFeature({ events: [AccountCreditedEvent] })],
	providers: [
		AccountSnapshotRepository,
		AccountRepository,
		OpenAccountCommandHandler,
		CreditAccountCommandHandler,
		GetAccountQueryHandler,
		RecordingSubscriber,
	],
})
class AccountsModule {}

const forRoot = (): DynamicModule => EventSourcingModule.forRoot({ events: [AccountOpenedEvent] });
const forRootAsync = (): DynamicModule =>
	EventSourcingModule.forRootAsync({ useFactory: async () => ({ events: [AccountOpenedEvent] }) });

// ---- checks ---------------------------------------------------------------------------------------------------------

async function scenario(variant: string, root: DynamicModule): Promise<void> {
	@Module({ imports: [root, AccountsModule] })
	class AppModule {}

	received.length = 0;
	const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
	await app.init();

	const commandBus = app.get(CommandBus);
	const queryBus = app.get(QueryBus);
	const eventStore = app.get(EventStore);
	const eventBus = app.get(EventBus);
	const deliveryErrors: EventDeliveryError[] = [];
	eventBus.deliveryErrors$.subscribe((error) => deliveryErrors.push(error));

	const accountId: string = await commandBus.execute(new OpenAccountCommand());
	await commandBus.execute(new CreditAccountCommand(accountId, [10, 20, 30]));
	const account: { balance: number; version: number } = await queryBus.execute(new GetAccountQuery(accountId));
	check(
		account.balance === 60 && account.version === 4,
		`${variant}: replayed balance 60 at v4 (${JSON.stringify(account)})`,
	);

	const snapshot = await app.get(AccountSnapshotRepository).load(AccountId.from(accountId));
	check(snapshot.version >= 2, `${variant}: snapshot taken (v${snapshot.version})`);

	// The subscribers run after the append resolved: wait for them instead of for a fixed time
	await eventBus.whenIdle({ timeout: 5_000 });
	check(
		received.join() ===
			'consumer-account-opened,consumer-account-credited,consumer-account-credited,consumer-account-credited',
		`${variant}: subscriber received every event (${received.join()})`,
	);

	// A stale expected version must surface as the core exception class: one module instance, not a dual package.
	const stream = EventStream.for<Account>(Account, AccountId.from(accountId));
	const conflict = await eventStore.appendEvents(stream, 1, [new AccountCreditedEvent(1)]).catch((error) => error);
	check(
		conflict instanceof EventStoreVersionConflictException,
		`${variant}: version conflict maps to the core exception`,
	);

	// The v4 form of an append: the expected version is the version of the stream before the append
	const [appended] = await eventStore.appendEvents(stream, [new AccountCreditedEvent(5)], {
		expectedVersion: 4,
		metadata: { correlationId: `consumer-${variant}` },
	});
	const position = appended?.metadata.globalPosition;
	check(
		appended?.metadata.version === 5 && typeof position === 'bigint',
		`${variant}: an append with options returns the envelope with its global position`,
	);
	const all: EventEnvelope[] = [];
	for await (const batch of eventStore.readAll({ fromPosition: position })) {
		all.push(...batch);
	}
	check(
		all.length === 1 &&
			all[0].metadata.eventId.value === appended.metadata.eventId.value &&
			all[0].metadata.correlationId === `consumer-${variant}`,
		`${variant}: readAll resumes at the global position of the append`,
	);

	await app.close();
	check(deliveryErrors.length === 0, `${variant}: no delivery errors (${deliveryErrors.length})`);
}

// The testing subpath loads without a test runner (its conformance suites need one to register their tests), through
// require(esm) in the CommonJS build, and its helpers build the stores of the root entry point: one module instance.
async function testingHelpers(): Promise<void> {
	const { store, publisher } = await createInMemoryEventStore({ events: [AccountOpenedEvent] });
	const id = AccountId.generate();
	const [envelope] = await store.appendEvents(
		EventStream.for<Account>(Account, id),
		[new AccountOpenedEvent(id.value)],
		{ expectedVersion: 0 },
	);
	check(
		store instanceof EventStore &&
			publisher instanceof RecordingPublisher &&
			publisher.calls.length === 1 &&
			publisher.calls[0][0]?.metadata.eventId.value === envelope?.metadata.eventId.value,
		'testing: createInMemoryEventStore builds a core store that publishes to a RecordingPublisher',
	);
	const snapshotStore = await createInMemorySnapshotStore();
	check(
		snapshotStore instanceof SnapshotStore && EVENT_STORE_CONFORMANCE_CASES.includes('read-all-gap-safe'),
		'testing: the snapshot store helper and the case ids load',
	);
}

/**
 * The default JSON serializer refuses an event with class-transformer decorators at bootstrap, and the
 * '@ocoda/event-sourcing/class-transformer' entry point serializes it with its decorators.
 */
async function serializers(): Promise<void> {
	@Module({ imports: [EventSourcingModule.forRoot({ events: [FundsDepositedEvent] })] })
	class JsonDefaultModule {}

	const refused = await NestFactory.createApplicationContext(JsonDefaultModule, { logger: false }).then(
		() => undefined,
		(error: unknown) => error,
	);
	check(
		refused instanceof EventSourcingConfigurationException &&
			refused.issues.length === 1 &&
			refused.issues[0]?.kind === 'class-transformer-decorators',
		'the JSON default serializer refuses an event with class-transformer decorators at bootstrap',
	);

	@Module({
		imports: [
			EventSourcingModule.forRoot({
				events: [FundsDepositedEvent],
				defaultEventSerializer: ClassTransformerEventSerializer,
			}),
		],
	})
	class ClassTransformerModule {}

	const app = await NestFactory.createApplicationContext(ClassTransformerModule, { logger: ['error', 'warn'] });
	const eventStore = app.get(EventStore);
	const stream = EventStream.for<Account>(Account, AccountId.generate());
	await eventStore.appendEvents(stream, [new FundsDepositedEvent(new Money(7, 'EUR'))], { expectedVersion: 0 });
	const read = await eventStore.getEvent(stream, 1);
	check(
		read instanceof FundsDepositedEvent && read.amount instanceof Money && read.amount.amount === 7,
		'ClassTransformerEventSerializer reads back the nested class through @Type',
	);
	await app.close();
}

async function main(): Promise<void> {
	check(EventSourcingModule.name === 'EventSourcingModule', 'class names are preserved');
	check(
		Reflect.getMetadata('design:paramtypes', SnapshotRepository)?.[0] === SnapshotStore,
		'the published build carries design:paramtypes metadata',
	);
	const drivers = [
		MariaDBEventStore,
		MariaDBSnapshotStore,
		MongoDBEventStore,
		MongoDBSnapshotStore,
		PostgresEventStore,
		PostgresSnapshotStore,
	];
	const isStore = (driver: (typeof drivers)[number]) =>
		driver.prototype instanceof EventStore || driver.prototype instanceof SnapshotStore;
	check(
		drivers.every(isStore),
		`every integration loads with its driver (${drivers.map((driver) => driver.name).join(', ')})`,
	);

	await testingHelpers();
	await scenario('forRoot', forRoot());
	await scenario('forRootAsync', forRootAsync());
	await serializers();

	console.log(failures === 0 ? `CONSUMER OK (${format})` : `CONSUMER FAILED (${format}): ${failures} check(s)`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
	console.log(`FAIL  [${format}] ${error instanceof Error ? error.stack : String(error)}`);
	process.exit(1);
});
