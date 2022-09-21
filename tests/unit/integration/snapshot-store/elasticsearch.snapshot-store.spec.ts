import { Client } from '@elastic/elasticsearch';
import {
	Aggregate,
	AggregateRoot,
	Id,
	ISnapshot,
	SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStream,
	StreamReadingDirection,
} from '../../../../lib';
import { ElasticsearchSnapshotStore } from '../../../../lib/integration/snapshot-store';

class AccountId extends Id {}

@Aggregate({ streamName: 'account' })
class Account extends AggregateRoot {
	constructor(private readonly id: AccountId, private readonly balance: number) {
		super();
	}
}

describe(ElasticsearchSnapshotStore, () => {
	let client: Client;

	const accountId = AccountId.generate();
	const snapshotStream = SnapshotStream.for(Account, accountId);

	let snapshotStore: ElasticsearchSnapshotStore;
	let envelopes: SnapshotEnvelope[];

	const snapshots: ISnapshot<Account>[] = [{ balance: 50 }, { balance: 20 }, { balance: 60 }, { balance: 50 }];

	const seedSnapshots = async () => {
		await snapshotStore.appendSnapshot(snapshotStream, 10, snapshots[0]);
		await snapshotStore.appendSnapshot(snapshotStream, 20, snapshots[1]);
		await snapshotStore.appendSnapshot(snapshotStream, 30, snapshots[2]);
		await snapshotStore.appendSnapshot(snapshotStream, 40, snapshots[3]);
	};

	beforeAll(async () => {
		envelopes = [
			SnapshotEnvelope.create<Account>(snapshots[0], { aggregateId: accountId.value, version: 10 }),
			SnapshotEnvelope.create<Account>(snapshots[1], { aggregateId: accountId.value, version: 20 }),
			SnapshotEnvelope.create<Account>(snapshots[2], { aggregateId: accountId.value, version: 30 }),
			SnapshotEnvelope.create<Account>(snapshots[3], { aggregateId: accountId.value, version: 40 }),
		];

		client = new Client({ node: 'http://localhost:9200' });
		snapshotStore = new ElasticsearchSnapshotStore(client);
		await snapshotStore.setup();
	});

	afterEach(
		async () =>
			await client.deleteByQuery({
				index: snapshotStream.collection,
				body: { query: { match_all: {} } },
				refresh: true,
			}),
	);

	afterAll(async () => {
		await client.indices.delete({ index: snapshotStream.collection });
		await client.close();
	});

	it('should append snapshots', async () => {
		await seedSnapshots();

		const { body } = await client.search({
			index: snapshotStream.collection,
			body: {
				query: { bool: { must: [{ match: { streamId: snapshotStream.streamId } }] } },
				sort: { 'metadata.version': 'asc' },
			},
		});

		expect(body.hits.hits).toHaveLength(snapshots.length);

		body.hits.hits.forEach(({ _source }, index) => {
			expect(_source.streamId).toEqual(snapshotStream.streamId);
			expect(_source.payload).toEqual(envelopes[index].payload);
			expect(_source.metadata.aggregateId).toEqual(envelopes[index].metadata.aggregateId);
			expect(_source.metadata.registeredOn).toBeDefined();
			expect(_source.metadata.version).toEqual(envelopes[index].metadata.version);
		});
	});

	it('should retrieve snapshots', async () => {
		await seedSnapshots();

		const resolvedSnapshots = await snapshotStore.getSnapshots(snapshotStream);

		expect(resolvedSnapshots).toEqual(snapshots);
	});

	it('should retrieve a single snapshot', async () => {
		await seedSnapshots();

		const resolvedSnapshot = await snapshotStore.getSnapshot(snapshotStream, envelopes[1].metadata.version);

		expect(resolvedSnapshot).toEqual(snapshots[1]);
	});

	it("should throw when a snapshot isn't found", async () => {
		await expect(snapshotStore.getSnapshot(snapshotStream, 5)).rejects.toThrow(
			new SnapshotNotFoundException(snapshotStream.streamId, 5),
		);
	});

	it('should retrieve snapshots backwards', async () => {
		await seedSnapshots();

		const resolvedSnapshots = await snapshotStore.getSnapshots(snapshotStream, null, StreamReadingDirection.BACKWARD);

		expect(resolvedSnapshots).toEqual(snapshots.slice().reverse());
	});

	it('should retrieve snapshots forward from a certain version', async () => {
		await seedSnapshots();

		const resolvedSnapshots = await snapshotStore.getSnapshots(snapshotStream, envelopes[1].metadata.version);

		expect(resolvedSnapshots).toEqual(
			snapshots.filter((_, index) => (index + 1) * 10 >= envelopes[1].metadata.version),
		);
	});

	it('should retrieve snapshots backwards from a certain version', async () => {
		await seedSnapshots();

		const resolvedSnapshots = await snapshotStore.getSnapshots(
			snapshotStream,
			envelopes[1].metadata.version,
			StreamReadingDirection.BACKWARD,
		);

		expect(resolvedSnapshots).toEqual(
			snapshots.filter((_, index) => (index + 1) * 10 >= envelopes[1].metadata.version).reverse(),
		);
	});

	it('should retrieve the last snapshot', async () => {
		await seedSnapshots();

		const resolvedSnapshot = await snapshotStore.getLastSnapshot(snapshotStream);

		expect(resolvedSnapshot).toEqual(snapshots[snapshots.length - 1]);
	});

	it('should return undefined if there is no last snapshot', async () => {
		@Aggregate({ streamName: 'foo' })
		class Foo extends AggregateRoot {}

		const resolvedSnapshot = await snapshotStore.getLastSnapshot(SnapshotStream.for(Foo, Id.generate()));

		expect(resolvedSnapshot).toBeUndefined();
	});

	it('should retrieve snapshot-envelopes', async () => {
		await seedSnapshots();

		const resolvedEnvelopes = await snapshotStore.getEnvelopes(snapshotStream);

		expect(resolvedEnvelopes).toHaveLength(envelopes.length);

		resolvedEnvelopes.forEach((envelope, index) => {
			expect(envelope.payload).toEqual(envelopes[index].payload);
			expect(envelope.metadata.aggregateId).toEqual(envelopes[index].metadata.aggregateId);
			expect(envelope.metadata.registeredOn).toBeInstanceOf(Date);
			expect(envelope.metadata.version).toEqual(envelopes[index].metadata.version);
		});
	});

	it('should retrieve a single snapshot-envelope', async () => {
		await seedSnapshots();

		const { metadata, payload } = await snapshotStore.getEnvelope(snapshotStream, envelopes[3].metadata.version);

		expect(payload).toEqual(envelopes[3].payload);
		expect(metadata.aggregateId).toEqual(envelopes[3].metadata.aggregateId);
		expect(metadata.registeredOn).toBeInstanceOf(Date);
		expect(metadata.version).toEqual(envelopes[3].metadata.version);
	});

	it('should retrieve the last snapshot-envelope', async () => {
		await seedSnapshots();

		const lastEnvelope = envelopes[envelopes.length - 1];
		const { metadata, payload } = await snapshotStore.getLastEnvelope(snapshotStream);

		expect(payload).toEqual(lastEnvelope.payload);
		expect(metadata.aggregateId).toEqual(lastEnvelope.metadata.aggregateId);
		expect(metadata.registeredOn).toBeInstanceOf(Date);
		expect(metadata.version).toEqual(lastEnvelope.metadata.version);
	});
});
