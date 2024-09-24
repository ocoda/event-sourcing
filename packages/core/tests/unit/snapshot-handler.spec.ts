import { Logger } from '@nestjs/common';
import {
	Aggregate,
	AggregateRoot,
	type ISnapshot,
	type ISnapshotPool,
	Snapshot,
	SnapshotEnvelope,
	SnapshotHandler,
	type SnapshotStore,
	SnapshotStream,
	UUID,
} from '@ocoda/event-sourcing';

describe(SnapshotHandler, () => {
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
	class AccountSnapshotHandler extends SnapshotHandler<Account> {
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

	let snapshotHandler: SnapshotHandler<Account>;
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

		snapshotHandler = new AccountSnapshotHandler(snapshotStore);
	});

	it('only stores snapshots in the snapshot-store at specified intervals', () => {
		account.version = 3;
		snapshotHandler.save(account.id, account);
		expect(snapshotStore.appendSnapshot).not.toHaveBeenCalled();

		account.version = snapshotInterval;
		snapshotHandler.save(account.id, account);
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

	it('retrieves the latest snapshot as a snapshot-envelope', async () => {
		account.version = snapshotInterval;
		snapshotEnvelope = SnapshotEnvelope.create<Account>(snapshot, {
			aggregateId: snapshotStream.aggregateId,
			version: snapshotInterval,
		});

		const loadedAccount = await snapshotHandler.load(account.id);

		expect(snapshotStore.getLastEnvelope).toHaveBeenCalledWith(snapshotStream, undefined);

		expect(loadedAccount).toEqual(account);
	});

	it('retrieves multiple snapshots as a snapshot-envelope', async () => {
		account.version = snapshotInterval;
		snapshotEnvelope = SnapshotEnvelope.create<Account>(snapshot, {
			aggregateId: snapshotStream.aggregateId,
			version: snapshotInterval,
		});

		const loadedAccounts = await snapshotHandler.loadMany([account.id]);

		expect(snapshotStore.getManyLastSnapshotEnvelopes).toHaveBeenCalledWith([snapshotStream], undefined);

		expect(loadedAccounts).toEqual([account]);
	});
});
