import { Client } from '@elastic/elasticsearch';
import {
	Aggregate,
	Id,
	ISnapshot,
	SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStream,
	StreamReadingDirection,
} from '../../../../lib';
import {
	ElasticsearchSnapshotEnvelopeEntity,
	ElasticsearchSnapshotStore,
} from '../../../../lib/integration/snapshot-store/elasticsearch.snapshot-store';

class Account extends Aggregate {
	constructor(private readonly id: AccountId, private readonly balance: number) {
		super();
	}
}
class AccountId extends Id {}

describe(ElasticsearchSnapshotStore, () => {
	let now = Date.now();
	let client: Client;
	let snapshotStore: ElasticsearchSnapshotStore;
	let snapshotEnvelopes: SnapshotEnvelope[];

	const accountId = AccountId.generate();
	const snapshotStream = SnapshotStream.for(Account, accountId);

	const snapshots: ISnapshot<Account>[] = [{ balance: 50 }, { balance: 20 }, { balance: 60 }, { balance: 50 }];

	beforeAll(async () => {
		jest.spyOn(global.Date, 'now').mockImplementation(() => now);
		client = new Client({ node: 'http://localhost:9200' });
		snapshotStore = new ElasticsearchSnapshotStore(client);

		snapshotEnvelopes = [
			SnapshotEnvelope.create<Account>(accountId, 10, snapshots[0]),
			SnapshotEnvelope.create<Account>(accountId, 20, snapshots[1]),
			SnapshotEnvelope.create<Account>(accountId, 30, snapshots[2]),
			SnapshotEnvelope.create<Account>(accountId, 40, snapshots[3]),
		];
	});

	afterAll(async () => {
		jest.clearAllMocks();
		await Promise.all([
			client.deleteByQuery({ index: snapshotStream.subject, body: { query: { match_all: {} } }, refresh: true }),
			client.deleteByQuery({ index: 'foo-snapshot', body: { query: { match_all: {} } }, refresh: true }),
		]);
		await client.close();
	});

	it('should append snapshots', async () => {
		await snapshotStore.appendSnapshot(accountId, 10, snapshotStream, snapshots[0]);
		await snapshotStore.appendSnapshot(accountId, 20, snapshotStream, snapshots[1]);
		await snapshotStore.appendSnapshot(accountId, 30, snapshotStream, snapshots[2]);
		await snapshotStore.appendSnapshot(accountId, 40, snapshotStream, snapshots[3]);

		const { body } = await client.search({
			index: snapshotStream.subject,
			body: {
				query: { bool: { must: [{ match: { stream: snapshotStream.name } }] } },
				sort: { 'metadata.sequence': 'asc' },
			},
		});
		expect(body.hits.hits).toHaveLength(4);

		const [hit1, hit2, hit3, hit4]: ElasticsearchSnapshotEnvelopeEntity<Account>[] = body.hits.hits;
		expect(hit1._source).toEqual({
			stream: snapshotStream.name,
			metadata: snapshotEnvelopes[0].metadata,
			payload: snapshotEnvelopes[0].payload,
		});
		expect(hit2._source).toEqual({
			stream: snapshotStream.name,
			metadata: snapshotEnvelopes[1].metadata,
			payload: snapshotEnvelopes[1].payload,
		});
		expect(hit3._source).toEqual({
			stream: snapshotStream.name,
			metadata: snapshotEnvelopes[2].metadata,
			payload: snapshotEnvelopes[2].payload,
		});
		expect(hit4._source).toEqual({
			stream: snapshotStream.name,
			metadata: snapshotEnvelopes[3].metadata,
			payload: snapshotEnvelopes[3].payload,
		});
	});

	it('should retrieve a single snapshot', async () => {
		const resolvedSnapshot = await snapshotStore.getSnapshot(snapshotStream, 20);

		expect(resolvedSnapshot).toEqual(snapshots[1]);
	});

	it("should throw when a snapshot isn't found", async () => {
		await expect(snapshotStore.getSnapshot(snapshotStream, 5)).rejects.toThrow(
			SnapshotNotFoundException.withVersion(snapshotStream.name, 5),
		);
	});

	it('should retrieve snapshots forward', async () => {
		const resolvedSnapshots = await snapshotStore.getSnapshots(snapshotStream);

		expect(resolvedSnapshots).toEqual(snapshots);
	});

	it('should retrieve snapshots backwards', async () => {
		const resolvedSnapshots = await snapshotStore.getSnapshots(
			snapshotStream,
			undefined,
			StreamReadingDirection.BACKWARD,
		);

		expect(resolvedSnapshots).toEqual(snapshots.slice().reverse());
	});

	it('should retrieve snapshots forward from a certain version', async () => {
		const resolvedSnapshots = await snapshotStore.getSnapshots(snapshotStream, 20);

		expect(resolvedSnapshots).toEqual(snapshots.filter((_, index) => (index + 1) * 10 >= 20));
	});

	it('should retrieve snapshots backwards from a certain version', async () => {
		const resolvedSnapshots = await snapshotStore.getSnapshots(snapshotStream, 20, StreamReadingDirection.BACKWARD);

		expect(resolvedSnapshots).toEqual(snapshots.filter((_, index) => (index + 1) * 10 >= 20).reverse());
	});

	it('should retrieve the last snapshot', async () => {
		const resolvedSnapshot = await snapshotStore.getLastSnapshot(snapshotStream);

		expect(resolvedSnapshot).toEqual(snapshots[snapshots.length - 1]);
	});

	it('should return undefined if there is no last snapshot', async () => {
		class Foo extends Aggregate {}
		const resolvedSnapshot = await snapshotStore.getLastSnapshot(SnapshotStream.for(Foo, Id.generate()));

		expect(resolvedSnapshot).toBeUndefined();
	});
});
