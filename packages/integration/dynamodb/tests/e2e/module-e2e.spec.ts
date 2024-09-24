import { DeleteTableCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
	CommandBus,
	EventCollection,
	EventStore,
	type ICommandBus,
	type IEventPublisher,
	type IQueryBus,
	QueryBus,
	SnapshotCollection,
	SnapshotStore,
} from '@ocoda/event-sourcing';
import type { DynamoDBEventStore, DynamoDBSnapshotStore } from '@ocoda/event-sourcing-dynamodb';
import {
	AccountRepository,
	AddAccountOwnerCommand,
	CloseAccountCommand,
	CreditAccountCommand,
	CustomEventPublisher,
	DebitAccountCommand,
	GetAccountByIdQuery,
	GetAccountsQuery,
	OpenAccountCommand,
	RemoveAccountOwnerCommand,
} from '@ocoda/event-sourcing-testing/e2e/application';
import { type Account, type AccountId, AccountOwnerId } from '@ocoda/event-sourcing-testing/e2e/domain';
import { AppModule } from './src/app.module';

describe('EventSourcingModule - e2e', () => {
	let app: INestApplication;
	let commandBus: ICommandBus;
	let queryBus: IQueryBus;
	let customEventPublisher: IEventPublisher;
	let eventStoreClient: DynamoDBClient;
	let snapshotStoreClient: DynamoDBClient;

	let accountId: AccountId;
	let accountOwnerIds: AccountOwnerId[];
	let balance = 0;
	let expectedVersion = 0;
	let openedOn: Date;

	let accountRepository: AccountRepository;

	beforeAll(async () => {
		const moduleRef = await Test.createTestingModule({
			imports: [AppModule],
		}).compile();

		app = moduleRef.createNestApplication();
		await app.init();

		const eventStore = app.get<DynamoDBEventStore>(EventStore);
		const snapshotStore = app.get<DynamoDBSnapshotStore>(SnapshotStore);
		await Promise.all([eventStore.ensureCollection('e2e'), snapshotStore.ensureCollection('e2e')]);
		// biome-ignore lint/complexity/useLiteralKeys: Needed to clear the event collection
		eventStoreClient = eventStore['client'];
		// biome-ignore lint/complexity/useLiteralKeys: Needed to clear the snapshot collection
		snapshotStoreClient = snapshotStore['client'];

		commandBus = app.get<CommandBus>(CommandBus);
		queryBus = app.get<QueryBus>(QueryBus);
		customEventPublisher = app.get<IEventPublisher>(CustomEventPublisher);

		customEventPublisher.publish = jest.fn((_) => Promise.resolve());

		accountRepository = app.get<AccountRepository>(AccountRepository);
	});

	afterAll(async () => {
		await Promise.all([
			eventStoreClient.send(new DeleteTableCommand({ TableName: EventCollection.get('e2e') })),
			snapshotStoreClient.send(new DeleteTableCommand({ TableName: SnapshotCollection.get('e2e') })),
		]);
		await app.close();
	});

	it('should open an account', async () => {
		const command = new OpenAccountCommand();
		accountId = await commandBus.execute(command);
		expectedVersion++;

		expect(customEventPublisher.publish).toHaveBeenCalledTimes(1);

		const account = await accountRepository.getById(accountId);
		openedOn = account.openedOn;

		expect(account.version).toBe(expectedVersion);

		expect(account.id).toEqual(accountId);
		expect(account.ownerIds).toEqual([]);
		expect(account.balance).toBe(0);
		expect(account.openedOn).toBeInstanceOf(Date);
		expect(account.closedOn).toBeUndefined();
	});

	it('should add owners to an account', async () => {
		accountOwnerIds = [
			AccountOwnerId.generate(),
			AccountOwnerId.generate(),
			AccountOwnerId.generate(),
			AccountOwnerId.generate(),
		];

		for (const ownerId of accountOwnerIds) {
			const command = new AddAccountOwnerCommand(accountId.value, ownerId.value);
			await commandBus.execute(command);
			expectedVersion++;

			const account = await accountRepository.getById(accountId);

			expect(account.version).toBe(expectedVersion);

			expect(account.id).toEqual(accountId);
			expect(account.ownerIds).toEqual(accountOwnerIds.slice(0, accountOwnerIds.indexOf(ownerId) + 1));
			expect(account.balance).toBe(0);
			expect(account.openedOn).toEqual(openedOn);
			expect(account.closedOn).toBeUndefined();
		}

		expect(customEventPublisher.publish).toHaveBeenCalledTimes(5);
	});

	it('should remove owners from an account', async () => {
		const ownersToRemove = accountOwnerIds.splice(2, 4);

		for (const ownerId of ownersToRemove) {
			const command = new RemoveAccountOwnerCommand(accountId.value, ownerId.value);
			await commandBus.execute(command);
			expectedVersion++;

			const account = await accountRepository.getById(accountId);

			expect(account.version).toBe(expectedVersion);

			expect(account.id).toEqual(accountId);
			expect(account.ownerIds).not.toContain(ownerId);
			expect(account.balance).toBe(0);
			expect(account.openedOn).toEqual(openedOn);
			expect(account.closedOn).toBeUndefined();
		}

		expect(customEventPublisher.publish).toHaveBeenCalledTimes(7);
	});

	it('should credit an account', async () => {
		const amounts = [10, 20, 30, 40, 50];

		for (const amount of amounts) {
			balance += amount;

			const command = new CreditAccountCommand(accountId.value, amount);
			await commandBus.execute(command);
			expectedVersion++;

			const account = await accountRepository.getById(accountId);

			expect(account.version).toBe(expectedVersion);

			expect(account.id).toEqual(accountId);
			expect(account.ownerIds).toEqual(accountOwnerIds);
			expect(account.balance).toBe(balance);
			expect(account.openedOn).toEqual(openedOn);
			expect(account.closedOn).toBeUndefined();
		}

		expect(customEventPublisher.publish).toHaveBeenCalledTimes(12);
	});

	it('should debit an account', async () => {
		const amounts = [5, 10, 15, 20, 25];

		for (const amount of amounts) {
			balance -= amount;

			const command = new DebitAccountCommand(accountId.value, amount);
			await commandBus.execute(command);
			expectedVersion++;

			const account = await accountRepository.getById(accountId);

			expect(account.version).toBe(expectedVersion);

			expect(account.id).toEqual(accountId);
			expect(account.ownerIds).toEqual(accountOwnerIds);
			expect(account.balance).toBe(balance);
			expect(account.openedOn).toEqual(openedOn);
			expect(account.closedOn).toBeUndefined();
		}

		expect(customEventPublisher.publish).toHaveBeenCalledTimes(17);
	});

	it('should get an account by id', async () => {
		const query = new GetAccountByIdQuery(accountId.value);
		const account = await queryBus.execute(query);

		expect(account.id).toEqual(accountId.value);
		expect(account.ownerIds).toEqual(accountOwnerIds.map((id) => id.value));
		expect(account.balance).toBe(balance);
		expect(account.openedOn).toEqual(openedOn.toISOString());
		expect(account.closedOn).toBeUndefined();
	});

	it('should close an account', async () => {
		const command = new CloseAccountCommand(accountId.value);
		await commandBus.execute(command);
		expectedVersion++;

		const account = await accountRepository.getById(accountId);

		expect(account.version).toBe(expectedVersion);

		expect(account.id).toEqual(accountId);
		expect(account.ownerIds).toEqual(accountOwnerIds);
		expect(account.balance).toBe(balance);
		expect(account.openedOn).toEqual(openedOn);
		expect(account.closedOn).toBeInstanceOf(Date);

		expect(customEventPublisher.publish).toHaveBeenCalledTimes(18);
	});

	it('should get all open accounts', async () => {
		const account2Id = await commandBus.execute<OpenAccountCommand, AccountId>(new OpenAccountCommand());
		const account3Id = await commandBus.execute<OpenAccountCommand, AccountId>(new OpenAccountCommand());

		const query = new GetAccountsQuery();
		const accounts = await queryBus.execute<GetAccountsQuery, Account[]>(query);

		expect(accounts).toHaveLength(2);
		expect(accounts.map(({ id }) => id).sort()).toEqual([account2Id.value, account3Id.value].sort());
	});
});
