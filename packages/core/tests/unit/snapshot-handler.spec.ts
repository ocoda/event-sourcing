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
	SnapshotStore,
	SnapshotStorePersistenceException,
	SnapshotStoreVersionConflictException,
	SnapshotStream,
	UUID,
	UnsupportedOperationException,
} from '@ocoda/event-sourcing';
import type { Mocked } from 'vitest';

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
	let snapshotStore: Mocked<SnapshotStore>;

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
			appendSnapshot: vi.fn(),
			getLastEnvelope: <any>(
				vi.fn((_snapshotStream: SnapshotStream, _pool?: ISnapshotPool) => Promise.resolve(snapshotEnvelope))
			),
			getManyLastSnapshotEnvelopes: vi.fn((snapshotStream: SnapshotStream, _pool?: ISnapshotPool) =>
				Promise.resolve(new Map([[snapshotStream, snapshotEnvelope]])),
			),
			getLastSnapshot: vi.fn(),
			getSnapshot: vi.fn(),
			getSnapshots: vi.fn(),
			start: vi.fn(),
			stop: vi.fn(),
		} as unknown as Mocked<SnapshotStore>;

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

	describe('when the snapshot fails', () => {
		beforeEach(() => {
			account.version = snapshotInterval;
		});

		it('logs a version conflict as a warning instead of rejecting', async () => {
			const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
			const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
			const conflict = new SnapshotStoreVersionConflictException({
				stream: snapshotStream,
				version: snapshotInterval,
				latestVersion: snapshotInterval,
				pool: 'tenant-1',
			});
			snapshotStore.appendSnapshot.mockRejectedValueOnce(conflict);

			await expect(snapshotRepository.save(account.id, account, 'tenant-1')).resolves.toBeUndefined();

			expect(snapshotStore.appendSnapshot).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith(
				`Skipped the snapshot of ${snapshotStream.streamId} at version ${snapshotInterval} in the tenant-1 pool: ${conflict.message}`,
			);
			expect(error).not.toHaveBeenCalled();
		});

		it('logs any other failure of the snapshot store as an error instead of rejecting', async () => {
			const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
			const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
			const failure = new SnapshotStorePersistenceException({ collection: 'snapshots' });
			snapshotStore.appendSnapshot.mockRejectedValueOnce(failure);

			await expect(snapshotRepository.save(account.id, account)).resolves.toBeUndefined();

			expect(error).toHaveBeenCalledWith(
				`Failed to save the snapshot of ${snapshotStream.streamId} at version ${snapshotInterval}; the aggregate still loads from its events.`,
				failure.stack,
			);
			expect(warn).not.toHaveBeenCalled();
		});

		it('logs a failure to serialize the aggregate as an error instead of rejecting', async () => {
			const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
			const failure = new TypeError('Cannot read properties of undefined');
			vi.spyOn(snapshotRepository, 'serialize').mockImplementationOnce(() => {
				throw failure;
			});

			await expect(snapshotRepository.save(account.id, account)).resolves.toBeUndefined();

			expect(snapshotStore.appendSnapshot).not.toHaveBeenCalled();
			expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to save the snapshot'), failure.stack);
		});

		it('logs a thrown value that is not an error', async () => {
			const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
			snapshotStore.appendSnapshot.mockRejectedValueOnce('connection reset');

			await expect(snapshotRepository.save(account.id, account)).resolves.toBeUndefined();

			expect(error).toHaveBeenCalledWith(expect.stringContaining('Failed to save the snapshot'), 'connection reset');
		});
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

		// The events a repository appends, marked as committed after the append
		const creditAndCommit = (wallet: Wallet, count: number) => {
			for (let i = 0; i < count; i++) {
				wallet.credit(1);
			}
			const events = wallet.getUncommittedEvents();
			wallet.markCommitted();
			return events;
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

		it('takes the snapshot at the boundary with the deprecated commit() too', async () => {
			const wallet = walletAt(9);
			wallet.credit(1);
			wallet.credit(1);
			expect(wallet.commit()).toHaveLength(2);

			await walletSnapshotRepository.save(walletId, wallet);

			expect(snapshotStore.appendSnapshot).toHaveBeenCalledWith(
				SnapshotStream.for(Wallet, walletId),
				11,
				{ balance: 2 },
				undefined,
			);
		});

		it('falls back to the interval multiples when markCommitted() was not called', async () => {
			// Uncommitted events: v9 -> v11, no multiple of the interval
			const wallet = walletAt(9);
			wallet.credit(1);
			wallet.credit(1);
			await walletSnapshotRepository.save(walletId, wallet);

			// Events from the history: v9 -> v11
			const loaded = walletAt(9);
			await loaded.loadFromHistory([new WalletCreditedEvent(1), new WalletCreditedEvent(1)]);
			await walletSnapshotRepository.save(walletId, loaded);
			expect(snapshotStore.appendSnapshot).not.toHaveBeenCalled();

			const walletAtBoundary = walletAt(20);
			await walletSnapshotRepository.save(walletId, walletAtBoundary);
			expect(snapshotStore.appendSnapshot).toHaveBeenCalledTimes(1);
			expect(snapshotStore.appendSnapshot).toHaveBeenCalledWith(
				SnapshotStream.for(Wallet, walletId),
				20,
				{ balance: 0 },
				undefined,
			);
		});

		it('falls back to the interval multiples when the aggregate changed after markCommitted()', async () => {
			const wallet = walletAt(9);
			creditAndCommit(wallet, 2); // v11, crossed the boundary
			wallet.credit(1); // v12, not committed

			await walletSnapshotRepository.save(walletId, wallet);
			expect(snapshotStore.appendSnapshot).not.toHaveBeenCalled();
		});

		it('takes no snapshot when markCommitted() committed nothing, even at a multiple of the interval', async () => {
			const wallet = walletAt(9);
			creditAndCommit(wallet, 2); // v11, crossed the boundary
			expect(creditAndCommit(wallet, 0)).toEqual([]); // an unchanged save

			await walletSnapshotRepository.save(walletId, wallet);
			expect(snapshotStore.appendSnapshot).not.toHaveBeenCalled();

			// Loaded at a multiple and saved unchanged: the stream may already have this snapshot, which would conflict
			const walletAtBoundary = walletAt(20);
			walletAtBoundary.markCommitted();
			await walletSnapshotRepository.save(walletId, walletAtBoundary);
			expect(snapshotStore.appendSnapshot).not.toHaveBeenCalled();
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
		snapshotStore.getLastEnvelope = vi.fn().mockResolvedValue(undefined);

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

	it("loads many with the base default, one getLastEnvelope per stream, when the store doesn't override it", async () => {
		snapshotStore.getManyLastSnapshotEnvelopes = vi.fn(
			SnapshotStore.prototype.getManyLastSnapshotEnvelopes,
		) as typeof snapshotStore.getManyLastSnapshotEnvelopes;
		account.version = snapshotInterval;
		snapshotEnvelope = SnapshotEnvelope.create<Account>(snapshot, {
			aggregateId: snapshotStream.aggregateId,
			version: snapshotInterval,
		});
		const otherId = AccountId.generate();
		snapshotStore.getLastEnvelope.mockImplementation(async (stream: SnapshotStream) =>
			stream.aggregateId === account.id.value ? snapshotEnvelope : undefined,
		);

		const loadedAccounts = await snapshotRepository.loadMany([account.id, otherId], 'tenant-1');

		expect(loadedAccounts).toEqual([account]);
		expect(snapshotStore.getLastEnvelope).toHaveBeenCalledTimes(2);
		expect(snapshotStore.getLastEnvelope).toHaveBeenNthCalledWith(1, snapshotStream, 'tenant-1');
		expect(snapshotStore.getLastEnvelope).toHaveBeenNthCalledWith(2, SnapshotStream.for(Account, otherId), 'tenant-1');
	});

	it("rejects loading all with the UnsupportedOperationException of the base default when the store doesn't override it", async () => {
		snapshotStore.getLastEnvelopesForAggregate = vi.fn(
			SnapshotStore.prototype.getLastEnvelopesForAggregate,
		) as typeof snapshotStore.getLastEnvelopesForAggregate;

		const iterator = snapshotRepository.loadAll();
		await expect(iterator.next()).rejects.toThrow(
			new UnsupportedOperationException({ operation: 'getLastEnvelopesForAggregate', component: 'snapshot store' }),
		);
		expect(snapshotStore.getLastEnvelopesForAggregate).toHaveBeenCalledWith(Account, {
			aggregateId: undefined,
		});
	});
});
