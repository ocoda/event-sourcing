import { Logger } from '@nestjs/common';
import {
	Aggregate,
	AggregateRoot,
	Event,
	EventHandler,
	type IEvent,
	type ISnapshot,
	type ISnapshotPool,
	Snapshot,
	SnapshotEnvelope,
	SnapshotRepository,
	type SnapshotStore,
	SnapshotStream,
	UUID,
} from '@ocoda/event-sourcing';

describe(SnapshotRepository, () => {
	@Aggregate()
	class Account extends AggregateRoot {
		public id: AccountId;
		public name: string;
		public balance: number;
		public openedOn: Date;
	}

	class AccountId extends UUID {}

	const snapshotInterval = 5;

	@Snapshot(Account, {
		name: 'account',
		interval: snapshotInterval,
	})
	class AccountSnapshotRepository extends SnapshotRepository<Account> {
		serialize({ id, name, balance, openedOn }: Account) {
			return {
				id: id.value,
				name,
				balance,
				openedOn: openedOn ? openedOn.toISOString() : undefined,
			};
		}
		deserialize({ id, name, balance, openedOn }: ISnapshot<Account>): Account {
			const account = new Account();
			account.id = AccountId.from(id);
			account.name = name;
			account.balance = balance;
			account.openedOn = openedOn && new Date(openedOn);

			return account;
		}
	}

	let snapshotRepository: SnapshotRepository<Account>;
	let account: Account;
	let snapshot: ISnapshot<Account>;
	let snapshotStream: SnapshotStream;
	let snapshotEnvelope: SnapshotEnvelope<Account>;
	let snapshotStore: jest.Mocked<SnapshotStore>;

	beforeEach(() => {
		account = new Account();
		account.id = AccountId.generate();
		account.name = "John Doe's Account";
		account.balance = 100;
		account.openedOn = new Date();

		snapshotStream = SnapshotStream.for(Account, account.id);

		snapshot = {
			id: account.id.value,
			name: account.name,
			balance: account.balance,
			openedOn: account.openedOn.toISOString(),
		};

		snapshotStore = {
			options: {},
			logger: new Logger(),
			appendSnapshot: jest.fn(),
			getLastEnvelope: <any>(
				jest.fn((_snapshotStream: SnapshotStream, _pool?: ISnapshotPool) => Promise.resolve(snapshotEnvelope))
			),
			getManyLastSnapshotEnvelopes: jest.fn((snapshotStream: SnapshotStream, _pool?: ISnapshotPool) =>
				Promise.resolve(new Map([[snapshotStream, snapshotEnvelope]])),
			),
			getLastSnapshot: jest.fn(),
			getSnapshot: jest.fn(),
			getSnapshots: jest.fn(),
			start: jest.fn(),
			stop: jest.fn(),
		} as unknown as jest.Mocked<SnapshotStore>;

		snapshotRepository = new AccountSnapshotRepository(snapshotStore);
	});

	it('only stores snapshots in the snapshot-store at specified intervals', () => {
		account.version = 3;
		snapshotRepository.save(account.id, account);
		expect(snapshotStore.appendSnapshot).not.toHaveBeenCalled();

		account.version = snapshotInterval;
		snapshotRepository.save(account.id, account);
		expect(snapshotStore.appendSnapshot).toHaveBeenCalledWith(
			snapshotStream,
			snapshotInterval,
			{
				...snapshot,
				id: account.id.value,
				openedOn: account.openedOn.toISOString(),
			},
			undefined,
		);
	});

	it('stores a snapshot when the version is one', async () => {
		account.version = 1;
		await snapshotRepository.save(account.id, account);

		expect(snapshotStore.appendSnapshot).toHaveBeenCalledWith(
			snapshotStream,
			1,
			{
				...snapshot,
				id: account.id.value,
				openedOn: account.openedOn.toISOString(),
			},
			undefined,
		);
	});

	describe('when the committed events are known', () => {
		@Event('snapshot-interval-wallet-credited')
		class WalletCreditedEvent implements IEvent {
			constructor(public readonly amount: number) {}
		}

		@Aggregate({ streamName: 'snapshot-interval-wallet' })
		class Wallet extends AggregateRoot {
			public balance = 0;

			credit(amount: number) {
				this.applyEvent(new WalletCreditedEvent(amount));
			}

			@EventHandler(WalletCreditedEvent)
			onWalletCredited({ amount }: WalletCreditedEvent) {
				this.balance += amount;
			}
		}

		const walletInterval = 10;

		@Snapshot(Wallet, { name: 'wallet', interval: walletInterval })
		class WalletSnapshotRepository extends SnapshotRepository<Wallet> {
			serialize({ balance }: Wallet) {
				return { balance };
			}
			deserialize({ balance }: ISnapshot<Wallet>): Wallet {
				const wallet = new Wallet();
				wallet.balance = balance;
				return wallet;
			}
		}

		const walletId = UUID.generate();
		let walletSnapshotRepository: WalletSnapshotRepository;

		const walletAt = (version: number) => {
			const wallet = new Wallet();
			wallet.version = version;
			return wallet;
		};

		const creditAndCommit = (wallet: Wallet, count: number) => {
			for (let i = 0; i < count; i++) {
				wallet.credit(1);
			}
			return wallet.commit();
		};

		beforeEach(() => {
			walletSnapshotRepository = new WalletSnapshotRepository(snapshotStore);
		});

		it.each([
			// [previous version, committed events, snapshot expected]
			[9, 2, true], // v9 -> v11 jumps over the interval boundary
			[8, 2, true], // v8 -> v10 lands on the interval boundary
			[19, 12, true], // v19 -> v31 jumps over multiple interval boundaries
			[0, 3, true], // v0 -> v3 a new aggregate is created with multiple events
			[0, 1, true], // v0 -> v1 a new aggregate is created with a single event
			[10, 1, false], // v10 -> v11 was snapshotted at the boundary before
			[11, 3, false], // v11 -> v14 stays within the interval
			[1, 8, false], // v1 -> v9 stays within the interval
		])(
			'from version %i with %i committed events, takes a snapshot: %s',
			async (previousVersion, eventCount, expected) => {
				const wallet = walletAt(previousVersion);
				expect(creditAndCommit(wallet, eventCount)).toHaveLength(eventCount);
				expect(wallet.version).toBe(previousVersion + eventCount);

				await walletSnapshotRepository.save(walletId, wallet);

				if (expected) {
					expect(snapshotStore.appendSnapshot).toHaveBeenCalledTimes(1);
					expect(snapshotStore.appendSnapshot).toHaveBeenCalledWith(
						SnapshotStream.for(Wallet, walletId),
						previousVersion + eventCount,
						{ balance: eventCount },
						undefined,
					);
				} else {
					expect(snapshotStore.appendSnapshot).not.toHaveBeenCalled();
				}
			},
		);

		it('passes the pool when a snapshot is taken after crossing the interval boundary', async () => {
			const wallet = walletAt(9);
			creditAndCommit(wallet, 2);

			await walletSnapshotRepository.save(walletId, wallet, 'tenant-1');

			expect(snapshotStore.appendSnapshot).toHaveBeenCalledWith(
				SnapshotStream.for(Wallet, walletId),
				11,
				{ balance: 2 },
				'tenant-1',
			);
		});

		it('falls back to the interval multiples when commit() was not called', async () => {
			const wallet = walletAt(9);
			wallet.credit(1);
			wallet.credit(1);

			await walletSnapshotRepository.save(walletId, wallet);
			expect(snapshotStore.appendSnapshot).not.toHaveBeenCalled();

			wallet.version = 20;
			await walletSnapshotRepository.save(walletId, wallet);
			expect(snapshotStore.appendSnapshot).toHaveBeenCalledTimes(1);
			expect(snapshotStore.appendSnapshot).toHaveBeenCalledWith(
				SnapshotStream.for(Wallet, walletId),
				20,
				{ balance: 2 },
				undefined,
			);
		});

		it('falls back to the interval multiples when the aggregate changed after commit()', async () => {
			const wallet = walletAt(9);
			creditAndCommit(wallet, 2); // v11, crossed the boundary
			wallet.credit(1); // v12, not committed

			await walletSnapshotRepository.save(walletId, wallet);
			expect(snapshotStore.appendSnapshot).not.toHaveBeenCalled();
		});

		it('falls back to the interval multiples when commit() had no events', async () => {
			const wallet = walletAt(9);
			creditAndCommit(wallet, 2); // v11, crossed the boundary
			expect(wallet.commit()).toEqual([]); // nothing new

			await walletSnapshotRepository.save(walletId, wallet);
			expect(snapshotStore.appendSnapshot).not.toHaveBeenCalled();

			const walletAtBoundary = walletAt(20);
			expect(walletAtBoundary.commit()).toEqual([]);
			await walletSnapshotRepository.save(walletId, walletAtBoundary);
			expect(snapshotStore.appendSnapshot).toHaveBeenCalledTimes(1);
		});

		it('does not leak the commit bookkeeping into the aggregate', () => {
			const wallet = walletAt(9);
			const keysBefore = Reflect.ownKeys(wallet);

			creditAndCommit(wallet, 2);

			expect(Reflect.ownKeys(wallet)).toEqual(keysBefore);
			expect(JSON.parse(JSON.stringify(wallet))).toEqual({ balance: 2 });
			expect(walletSnapshotRepository.serialize(wallet)).toEqual({ balance: 2 });
		});
	});

	it('retrieves the latest snapshot as a snapshot-envelope', async () => {
		account.version = snapshotInterval;
		snapshotEnvelope = SnapshotEnvelope.create<Account>(snapshot, {
			aggregateId: snapshotStream.aggregateId,
			version: snapshotInterval,
		});

		const loadedAccount = await snapshotRepository.load(account.id);

		expect(snapshotStore.getLastEnvelope).toHaveBeenCalledWith(snapshotStream, undefined);

		expect(loadedAccount).toEqual(account);
	});

	it('returns a new aggregate when no snapshots are found', async () => {
		snapshotStore.getLastEnvelope = jest.fn().mockResolvedValue(undefined);

		const loadedAccount = await snapshotRepository.load(account.id);

		expect(loadedAccount.version).toBe(0);
		expect(loadedAccount.name).toBeUndefined();
	});

	it('retrieves multiple snapshots as a snapshot-envelope', async () => {
		account.version = snapshotInterval;
		snapshotEnvelope = SnapshotEnvelope.create<Account>(snapshot, {
			aggregateId: snapshotStream.aggregateId,
			version: snapshotInterval,
		});

		const loadedAccounts = await snapshotRepository.loadMany([account.id]);

		expect(snapshotStore.getManyLastSnapshotEnvelopes).toHaveBeenCalledWith([snapshotStream], undefined);

		expect(loadedAccounts).toEqual([account]);
	});

	it('throws when loading many without store support', async () => {
		snapshotStore.getManyLastSnapshotEnvelopes = undefined;

		await expect(snapshotRepository.loadMany([account.id])).rejects.toThrow(
			'The snapshot store does not support method: getManyLastSnapshotEnvelopes.',
		);
	});

	it('throws when loading all without store support', async () => {
		snapshotStore.getLastEnvelopesForAggregate = undefined;

		const iterator = snapshotRepository.loadAll();
		await expect(iterator.next()).rejects.toThrow(
			'The snapshot store does not support method: getLastEnvelopesForAggregate.',
		);
	});
});
