import type { INestApplication } from '@nestjs/common';
import type { EventStoreDriver, SnapshotStoreDriver } from '@ocoda/event-sourcing';
import {
	CommandBus,
	EventCollection,
	type ICommandBus,
	type IEventPublisher,
	type IQueryBus,
	QueryBus,
	SnapshotCollection,
} from '@ocoda/event-sourcing';
import {
	AccountRepository,
	AddAccountOwnerCommand,
	CloseAccountCommand,
	CreditAccountCommand,
	CustomEventPublisher,
	DebitAccountCommand,
	GetAccountsByIdsQuery,
	GetAccountsQuery,
	OpenAccountCommand,
	RemoveAccountOwnerCommand,
	TransferBetweenAccountsCommand,
} from './application';
import { type Account, type AccountId, AccountOwnerId } from './domain';

export interface E2EStoreSetup<
	TEventStore extends EventStoreDriver,
	TSnapshotStore extends SnapshotStoreDriver,
	TCleanup,
> {
	resolveStores: (app: INestApplication) => Promise<{ eventStore: TEventStore; snapshotStore: TSnapshotStore }>;
	cleanup: (context: TCleanup) => Promise<void>;
	getCleanupContext: (eventStore: TEventStore, snapshotStore: TSnapshotStore) => TCleanup;
}

export interface E2ETestSuiteOptions<
	TEventStore extends EventStoreDriver,
	TSnapshotStore extends SnapshotStoreDriver,
	TCleanup,
> {
	appRef: { current?: INestApplication };
	storeSetup: E2EStoreSetup<TEventStore, TSnapshotStore, TCleanup>;
}

export const createDefaultStoreSetup = <
	TEventStore extends EventStoreDriver,
	TSnapshotStore extends SnapshotStoreDriver,
	TCleanup,
>(
	options: E2EStoreSetup<TEventStore, TSnapshotStore, TCleanup>,
) => options;

export const runAccountLifecycleE2E = async <
	TEventStore extends EventStoreDriver,
	TSnapshotStore extends SnapshotStoreDriver,
	TCleanup,
>(
	options: E2ETestSuiteOptions<TEventStore, TSnapshotStore, TCleanup>,
) => {
	const { appRef, storeSetup } = options;
	let commandBus: ICommandBus;
	let queryBus: IQueryBus;
	let customEventPublisher: IEventPublisher;
	let accountRepository: AccountRepository;

	let accountId: AccountId;
	let accountOwnerIds: AccountOwnerId[] = [];
	let balance = 0;
	let expectedVersion = 0;
	let openedOn: Date;
	let account2Id: AccountId;
	let account3Id: AccountId;
	let cleanupContext: TCleanup;

	beforeAll(async () => {
		const app = appRef.current;
		if (!app) {
			throw new Error('E2E app not initialized');
		}
		const { eventStore, snapshotStore } = await storeSetup.resolveStores(app);
		await Promise.all([eventStore.ensureCollection('e2e'), snapshotStore.ensureCollection('e2e')]);

		cleanupContext = storeSetup.getCleanupContext(eventStore, snapshotStore);

		commandBus = app.get<CommandBus>(CommandBus);
		queryBus = app.get<QueryBus>(QueryBus);
		customEventPublisher = app.get<IEventPublisher>(CustomEventPublisher);
		customEventPublisher.publish = jest.fn((_) => Promise.resolve());
		accountRepository = app.get<AccountRepository>(AccountRepository);
	});

	afterAll(async () => {
		await storeSetup.cleanup(cleanupContext);
		const app = appRef.current;
		if (app) {
			await app.close();
		}
	});

	it('should open an account with initial owners', async () => {
		accountOwnerIds = [AccountOwnerId.generate(), AccountOwnerId.generate()];
		const command = new OpenAccountCommand(accountOwnerIds.map(({ value }) => value));
		accountId = await commandBus.execute(command);
		expectedVersion++;

		expect(customEventPublisher.publish).toHaveBeenCalledTimes(1);

		const account = await accountRepository.getById(accountId);
		openedOn = account.openedOn;

		expect(account.version).toBe(expectedVersion);
		expect(account.id).toEqual(accountId);
		expect(account.ownerIds).toEqual(accountOwnerIds);
		expect(account.balance).toBe(0);
		expect(account.openedOn).toBeInstanceOf(Date);
		expect(account.closedOn ?? undefined).toBeUndefined();
	});

	it('should add a new owner to an account', async () => {
		const ownerId = AccountOwnerId.generate();
		await commandBus.execute(new AddAccountOwnerCommand(accountId.value, ownerId.value));
		expectedVersion++;
		accountOwnerIds = [...accountOwnerIds, ownerId];

		const account = await accountRepository.getById(accountId);
		expect(account.version).toBe(expectedVersion);
		expect(account.ownerIds).toEqual(accountOwnerIds);
		expect(account.balance).toBe(0);
		expect(account.closedOn ?? undefined).toBeUndefined();
	});

	it('should reject adding the same owner twice', async () => {
		await expect(
			commandBus.execute(new AddAccountOwnerCommand(accountId.value, accountOwnerIds[0].value)),
		).rejects.toThrow('Account owner already exists');
	});

	it('should reject removing a non-existent owner', async () => {
		const missingOwnerId = AccountOwnerId.generate();
		await expect(
			commandBus.execute(new RemoveAccountOwnerCommand(accountId.value, missingOwnerId.value)),
		).rejects.toThrow('Account owner not found');
	});

	it('should remove an owner', async () => {
		const ownerToRemove = accountOwnerIds[0];
		await commandBus.execute(new RemoveAccountOwnerCommand(accountId.value, ownerToRemove.value));
		expectedVersion++;
		accountOwnerIds = accountOwnerIds.filter((ownerId) => ownerId.value !== ownerToRemove.value);

		const account = await accountRepository.getById(accountId);
		expect(account.version).toBe(expectedVersion);
		expect(account.ownerIds).toEqual(accountOwnerIds);
		expect(account.balance).toBe(0);
		expect(account.closedOn ?? undefined).toBeUndefined();
	});

	it('should credit an account multiple times', async () => {
		const amounts = [25, 40, 55, 30, 20];
		for (const amount of amounts) {
			balance += amount;
			await commandBus.execute(new CreditAccountCommand(accountId.value, amount));
			expectedVersion++;
		}

		const account = await accountRepository.getById(accountId);
		expect(account.version).toBe(expectedVersion);
		expect(account.ownerIds).toEqual(accountOwnerIds);
		expect(account.balance).toBe(balance);
		// snapshot interval is 5, so by now at least one snapshot should have been taken
		expect(account.version).toBeGreaterThanOrEqual(6);
		expect(account.closedOn ?? undefined).toBeUndefined();
	});

	it('should reject invalid credit amounts', async () => {
		await expect(commandBus.execute(new CreditAccountCommand(accountId.value, 0))).rejects.toThrow(
			'Amount must be greater than zero',
		);
	});

	it('should debit an account', async () => {
		const amounts = [20, 15, 10];
		for (const amount of amounts) {
			balance -= amount;
			await commandBus.execute(new DebitAccountCommand(accountId.value, amount));
			expectedVersion++;
		}

		const account = await accountRepository.getById(accountId);
		expect(account.version).toBe(expectedVersion);
		expect(account.balance).toBe(balance);
		expect(account.closedOn ?? undefined).toBeUndefined();
	});

	it('should reject invalid debit amounts', async () => {
		await expect(commandBus.execute(new DebitAccountCommand(accountId.value, 0))).rejects.toThrow(
			'Amount must be greater than zero',
		);
	});

	it('should reject debits when insufficient funds', async () => {
		await expect(commandBus.execute(new DebitAccountCommand(accountId.value, balance + 999))).rejects.toThrow(
			'Insufficient funds',
		);
	});

	it('should open a second account for transfers', async () => {
		account2Id = await commandBus.execute<OpenAccountCommand, AccountId>(new OpenAccountCommand());
		expectedVersion++;

		const account = await accountRepository.getById(account2Id);
		expect(account.balance).toBe(0);
		expect(account.closedOn ?? undefined).toBeUndefined();
	});

	it('should transfer funds between accounts', async () => {
		const transferAmount = 30;
		await commandBus.execute(new TransferBetweenAccountsCommand(accountId.value, account2Id.value, transferAmount));

		const sourceAccount = await accountRepository.getById(accountId);
		const destinationAccount = await accountRepository.getById(account2Id);

		balance -= transferAmount;

		expect(sourceAccount.balance).toBe(balance);
		expect(destinationAccount.balance).toBe(transferAmount);
		expect(customEventPublisher.publish).toHaveBeenCalled();
	});

	it('should emit a transfer failure event when a transfer fails', async () => {
		await expect(
			commandBus.execute(new TransferBetweenAccountsCommand(accountId.value, account2Id.value, balance + 999)),
		).rejects.toThrow('Insufficient funds');

		const account = await accountRepository.getById(accountId);
		expect(customEventPublisher.publish).toHaveBeenCalled();
	});

	it('should query accounts by id and list open accounts', async () => {
		account3Id = await commandBus.execute<OpenAccountCommand, AccountId>(new OpenAccountCommand());

		const accounts = await queryBus.execute<GetAccountsByIdsQuery, Account[]>(
			new GetAccountsByIdsQuery([accountId.value, account2Id.value, account3Id.value]),
		);

		expect(accounts).toHaveLength(3);
		expect(accounts.map(({ id }) => id).sort()).toEqual([accountId.value, account2Id.value, account3Id.value].sort());

		const openAccounts = await queryBus.execute<GetAccountsQuery, Account[]>(new GetAccountsQuery());
		expect(openAccounts.map(({ id }) => id)).toContain(account3Id.value);
	});

	it('should close an account and prevent further changes', async () => {
		await commandBus.execute(new CloseAccountCommand(accountId.value));
		expectedVersion++;

		const account = await accountRepository.getById(accountId);
		expect(account.closedOn).toBeInstanceOf(Date);

		await expect(commandBus.execute(new CloseAccountCommand(accountId.value))).rejects.toThrow(
			'Account is already closed',
		);
		await expect(commandBus.execute(new DebitAccountCommand(accountId.value, 5))).rejects.toThrow(
			'Account is already closed',
		);
	});
};

export interface DynamoDBCleanupContext {
	eventStoreClient: { send: (command: unknown) => Promise<unknown> };
	snapshotStoreClient: { send: (command: unknown) => Promise<unknown> };
	deleteTable: (tableName: string) => unknown;
}

export const defaultCleanup = {
	async postgres(
		eventStoreClient: { query: (query: string) => Promise<unknown> },
		snapshotStoreClient: {
			query: (query: string) => Promise<unknown>;
		},
	) {
		await Promise.all([
			eventStoreClient.query(`DROP TABLE IF EXISTS "${EventCollection.get('e2e')}"`),
			snapshotStoreClient.query(`DROP TABLE IF EXISTS "${SnapshotCollection.get('e2e')}"`),
		]);
	},
	async mariadb(
		eventStoreClient: { query: (query: string) => Promise<unknown> },
		snapshotStoreClient: {
			query: (query: string) => Promise<unknown>;
		},
	) {
		await eventStoreClient.query(`DROP TABLE IF EXISTS \`${EventCollection.get('e2e')}\``);
		await snapshotStoreClient.query(`DROP TABLE IF EXISTS \`${SnapshotCollection.get('e2e')}\``);
	},
	async mongodb(
		eventStoreClient: { db: () => { dropCollection: (name: string) => Promise<unknown> } },
		snapshotStoreClient: {
			db: () => { dropCollection: (name: string) => Promise<unknown> };
		},
	) {
		await Promise.all([
			eventStoreClient.db().dropCollection(EventCollection.get('e2e')),
			snapshotStoreClient.db().dropCollection(SnapshotCollection.get('e2e')),
		]);
	},
	async dynamodb({ eventStoreClient, snapshotStoreClient, deleteTable }: DynamoDBCleanupContext) {
		await Promise.all([
			eventStoreClient.send(deleteTable(EventCollection.get('e2e'))),
			snapshotStoreClient.send(deleteTable(SnapshotCollection.get('e2e'))),
		]);
	},
};
