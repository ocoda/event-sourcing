import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CommandBus, EventStore, ICommandBus, SnapshotStore } from '@ocoda/event-sourcing';
import { AppModule } from './src/app.module';
import {
	AddAccountOwnerCommand,
	CloseAccountCommand,
	CreditAccountCommand,
	DebitAccountCommand,
	OpenAccountCommand,
	RemoveAccountOwnerCommand,
} from './src/application/commands';
import { AccountRepository } from './src/application/repositories';
import { AccountId, AccountOwnerId } from './src/domain/models';

describe('EventSourcingModule - e2e', () => {
	let app: INestApplication;
	let commandBus: ICommandBus;

	let accountId: AccountId;
	let accountOwnerIds: AccountOwnerId[];
	let balance = 0;
	let expectedVersion = 0;

	let accountRepository: AccountRepository;

	beforeAll(async () => {
		jest.useFakeTimers({ now: new Date() });

		const moduleRef = await Test.createTestingModule({
			imports: [AppModule],
		}).compile();

		app = moduleRef.createNestApplication();
		await app.init();

		app.get<SnapshotStore>(SnapshotStore).setup();
		app.get<EventStore>(EventStore).setup();

		commandBus = app.get<CommandBus>(CommandBus);
		accountRepository = app.get<AccountRepository>(AccountRepository);
	});

	afterAll(async () => {
		jest.useRealTimers();
		await app.close();
	});

	it('should open an account', async () => {
		const command = new OpenAccountCommand();
		accountId = await commandBus.execute(command);
		expectedVersion++;

		const account = await accountRepository.getById(accountId);

		expect(account.version).toBe(expectedVersion);

		expect(account.id).toEqual(accountId);
		expect(account.ownerIds).toEqual([]);
		expect(account.balance).toBe(0);
		expect(account.openedOn).toEqual(new Date());
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
			expect(account.openedOn).toEqual(new Date());
			expect(account.closedOn).toBeUndefined();
		}
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
			expect(account.openedOn).toEqual(new Date());
			expect(account.closedOn).toBeUndefined();
		}
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
			expect(account.openedOn).toEqual(new Date());
			expect(account.closedOn).toBeUndefined();
		}
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
			expect(account.openedOn).toEqual(new Date());
			expect(account.closedOn).toBeUndefined();
		}
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
		expect(account.openedOn).toEqual(new Date());
		expect(account.closedOn).toEqual(new Date());
	});
});
