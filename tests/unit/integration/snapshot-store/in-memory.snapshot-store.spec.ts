import {
	Aggregate,
	AggregateRoot,
	ISnapshot,
	SnapshotEnvelope,
	SnapshotNotFoundException,
	SnapshotStream,
	StreamReadingDirection,
	UUID,
} from '../../../../lib';
import { InMemorySnapshotStore } from '../../../../lib/integration/snapshot-store';

class AccountId extends UUID {}
class CustomerId extends UUID {}

@Aggregate({ streamName: 'account' })
class Account extends AggregateRoot {
	constructor(
		private readonly id: AccountId,
		private readonly balance: number,
	) {
		super();
	}
}

@Aggregate({ streamName: 'customer' })
class Customer extends AggregateRoot {
	constructor(
		private readonly id: CustomerId,
		private readonly name: string,
	) {
		super();
	}
}

describe(InMemorySnapshotStore, () => {
	let snapshotStore: InMemorySnapshotStore;
	let envelopesAccountA: SnapshotEnvelope[];
	let envelopesAccountB: SnapshotEnvelope[];

	const idAccountA = AccountId.generate();
	const snapshotStreamAccountA = SnapshotStream.for(Account, idAccountA);
	const snapshotsAccountA: ISnapshot<Account>[] = [
		{ balance: 0 },
		{ balance: 50 },
		{ balance: 20 },
		{ balance: 60 },
		{ balance: 50 },
	];

	const idAccountB = AccountId.generate();
	const snapshotStreamAccountB = SnapshotStream.for(Account, idAccountB);
	const snapshotsAccountB: ISnapshot<Account>[] = [{ balance: 0 }, { balance: 10 }, { balance: 20 }, { balance: 30 }];

	const customerSnapshot: ISnapshot<Customer> = { name: 'Hubert Farnsworth' };

	const customerId = CustomerId.generate();
	const snapshotStreamCustomer = SnapshotStream.for(Customer, customerId);

	beforeAll(() => {
		snapshotStore = new InMemorySnapshotStore();
		snapshotStore.setup();

		envelopesAccountA = [
			SnapshotEnvelope.create<Account>(snapshotsAccountA[0], {
				aggregateId: idAccountA.value,
				version: 1,
			}),
			SnapshotEnvelope.create<Account>(snapshotsAccountA[1], {
				aggregateId: idAccountA.value,
				version: 10,
			}),
			SnapshotEnvelope.create<Account>(snapshotsAccountA[2], {
				aggregateId: idAccountA.value,
				version: 20,
			}),
			SnapshotEnvelope.create<Account>(snapshotsAccountA[3], {
				aggregateId: idAccountA.value,
				version: 30,
			}),
			SnapshotEnvelope.create<Account>(snapshotsAccountA[4], {
				aggregateId: idAccountA.value,
				version: 40,
			}),
		];
		envelopesAccountB = [
			SnapshotEnvelope.create<Account>(snapshotsAccountB[0], {
				aggregateId: idAccountB.value,
				version: 1,
			}),
			SnapshotEnvelope.create<Account>(snapshotsAccountB[1], {
				aggregateId: idAccountB.value,
				version: 10,
			}),
			SnapshotEnvelope.create<Account>(snapshotsAccountB[2], {
				aggregateId: idAccountB.value,
				version: 20,
			}),
			SnapshotEnvelope.create<Account>(snapshotsAccountB[3], {
				aggregateId: idAccountB.value,
				version: 30,
			}),
		];
	});

	it('should append snapshot envelopes', () => {
		snapshotStore.appendSnapshot(snapshotStreamAccountA, 1, snapshotsAccountA[0]);
		snapshotStore.appendSnapshot(snapshotStreamAccountB, 1, snapshotsAccountB[0]);
		snapshotStore.appendSnapshot(snapshotStreamAccountA, 10, snapshotsAccountA[1]);
		snapshotStore.appendSnapshot(snapshotStreamAccountB, 10, snapshotsAccountB[1]);
		snapshotStore.appendSnapshot(snapshotStreamAccountA, 20, snapshotsAccountA[2]);
		snapshotStore.appendSnapshot(snapshotStreamAccountB, 20, snapshotsAccountB[2]);
		snapshotStore.appendSnapshot(snapshotStreamAccountA, 30, snapshotsAccountA[3]);
		snapshotStore.appendSnapshot(snapshotStreamAccountB, 30, snapshotsAccountB[3]);
		snapshotStore.appendSnapshot(snapshotStreamAccountA, 40, snapshotsAccountA[4]);
		snapshotStore.appendSnapshot(snapshotStreamCustomer, 1, customerSnapshot);
		snapshotStore.appendSnapshot(snapshotStreamCustomer, 10, customerSnapshot);

		const entities = snapshotStore.collections.get('snapshots') || [];
		const entitiesAccountA = entities.filter(
			({ streamId: entityStreamId }) => entityStreamId === snapshotStreamAccountA.streamId,
		);
		const entitiesAccountB = entities.filter(
			({ streamId: entityStreamId }) => entityStreamId === snapshotStreamAccountB.streamId,
		);
		const entitiesCustomer = entities.filter(
			({ streamId: entityStreamId }) => entityStreamId === snapshotStreamCustomer.streamId,
		);

		expect(entitiesAccountA).toHaveLength(snapshotsAccountA.length);
		expect(entitiesAccountB).toHaveLength(snapshotsAccountB.length);
		expect(entitiesCustomer).toHaveLength(2);

		for (const [index, entity] of entitiesAccountA.entries()) {
			expect(entity.streamId).toEqual(snapshotStreamAccountA.streamId);
			expect(entity.payload).toEqual(envelopesAccountA[index].payload);
			expect(entity.aggregateId).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(entity.registeredOn).toBeInstanceOf(Date);
			expect(entity.version).toEqual(envelopesAccountA[index].metadata.version);
		}
	});

	it('should retrieve a single snapshot from a specified stream', () => {
		const resolvedSnapshot = snapshotStore.getSnapshot(snapshotStreamAccountA, envelopesAccountA[1].metadata.version);

		expect(resolvedSnapshot).toEqual(snapshotsAccountA[1]);
	});

	it('should retrieve snapshots by stream', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA)) {
			resolvedSnapshots.push(...snapshots);
		}

		expect(resolvedSnapshots).toEqual(snapshotsAccountA);
	});

	it('should filter snapshots by stream and version', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, { fromVersion: 30 })) {
			resolvedSnapshots.push(...snapshots);
		}

		expect(resolvedSnapshots).toEqual(snapshotsAccountA.slice(3));
	});

	it("should throw when a snapshot isn't found in a specified stream", () => {
		const stream = SnapshotStream.for(Account, AccountId.generate());
		expect(() => snapshotStore.getSnapshot(stream, 20)).toThrow(new SnapshotNotFoundException(stream.streamId, 20));
	});

	it('should retrieve snapshots backwards', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, {
			direction: StreamReadingDirection.BACKWARD,
		})) {
			resolvedSnapshots.push(...snapshots);
		}

		expect(resolvedSnapshots).toEqual(snapshotsAccountA.slice().reverse());
	});

	it('should retrieve snapshots backwards from a certain version', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, {
			fromVersion: envelopesAccountA[1].metadata.version,
			direction: StreamReadingDirection.BACKWARD,
		})) {
			resolvedSnapshots.push(...snapshots);
		}

		expect(resolvedSnapshots).toEqual(
			snapshotsAccountA.filter((_, index) => (index + 1) * 10 >= envelopesAccountA[2].metadata.version).reverse(),
		);
	});

	it('should limit the returned snapshots', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, { limit: 2 })) {
			resolvedSnapshots.push(...snapshots);
		}

		expect(resolvedSnapshots).toEqual(snapshotsAccountA.slice(0, 2));
	});

	it('should batch the returned snapshots', async () => {
		const resolvedSnapshots: ISnapshot<Account>[] = [];
		for await (const snapshots of snapshotStore.getSnapshots(snapshotStreamAccountA, { limit: 2 })) {
			expect(snapshots.length).toBe(2);
			resolvedSnapshots.push(...snapshots);
		}

		expect(resolvedSnapshots).toEqual(snapshotsAccountA.slice(0, 2));
	});

	it('should retrieve the last snapshot', () => {
		const resolvedSnapshot = snapshotStore.getLastSnapshot(snapshotStreamAccountA);

		expect(resolvedSnapshot).toEqual(snapshotsAccountA[snapshotsAccountA.length - 1]);
	});

	it('should return undefined if there is no last snapshot', () => {
		@Aggregate({ streamName: 'foo' })
		class Foo extends AggregateRoot {}

		const resolvedSnapshot = snapshotStore.getLastSnapshot(SnapshotStream.for(Foo, UUID.generate()));

		expect(resolvedSnapshot).toBeUndefined();
	});

	it('should retrieve snapshot-envelopes', async () => {
		const resolvedEnvelopes: SnapshotEnvelope<Account>[] = [];
		for await (const envelopes of snapshotStore.getEnvelopes(snapshotStreamAccountA)) {
			resolvedEnvelopes.push(...envelopes);
		}

		expect(resolvedEnvelopes).toHaveLength(envelopesAccountA.length);

		for (const [index, envelope] of resolvedEnvelopes.entries()) {
			expect(envelope.payload).toEqual(envelopesAccountA[index].payload);
			expect(envelope.metadata.aggregateId).toEqual(envelopesAccountA[index].metadata.aggregateId);
			expect(envelope.metadata.registeredOn).toBeInstanceOf(Date);
			expect(envelope.metadata.version).toEqual(envelopesAccountA[index].metadata.version);
		}
	});

	it('should retrieve a single snapshot-envelope', async () => {
		const { metadata, payload } = snapshotStore.getEnvelope(
			snapshotStreamAccountA,
			envelopesAccountA[3].metadata.version,
		);

		expect(payload).toEqual(envelopesAccountA[3].payload);
		expect(metadata.aggregateId).toEqual(envelopesAccountA[3].metadata.aggregateId);
		expect(metadata.registeredOn).toBeInstanceOf(Date);
		expect(metadata.version).toEqual(envelopesAccountA[3].metadata.version);
	});

	it('should retrieve the last snapshot-envelope', async () => {
		const lastEnvelope = envelopesAccountA[envelopesAccountA.length - 1];
		const { metadata, payload } = snapshotStore.getLastEnvelope(snapshotStreamAccountA);

		expect(payload).toEqual(lastEnvelope.payload);
		expect(metadata.aggregateId).toEqual(lastEnvelope.metadata.aggregateId);
		expect(metadata.registeredOn).toBeInstanceOf(Date);
		expect(metadata.version).toEqual(lastEnvelope.metadata.version);
	});

	it('should retrieve the last snapshot-envelopes', async () => {
		let resolvedEnvelopes: SnapshotEnvelope<Account>[] = [];
		for await (const envelopes of snapshotStore.getLastEnvelopes('account')) {
			resolvedEnvelopes.push(...envelopes);
		}

		expect(resolvedEnvelopes).toHaveLength(2);

		const [envelopeAccountB, envelopeAccountA] = [
			envelopesAccountB[envelopesAccountB.length - 1],
			envelopesAccountA[envelopesAccountA.length - 1],
		];

		resolvedEnvelopes = resolvedEnvelopes.sort((a, b) => (a.metadata.version > b.metadata.version ? 1 : -1));

		expect(resolvedEnvelopes[0].payload).toEqual(envelopeAccountB.payload);
		expect(resolvedEnvelopes[0].metadata.aggregateId).toEqual(envelopeAccountB.metadata.aggregateId);
		expect(resolvedEnvelopes[0].metadata.registeredOn).toBeInstanceOf(Date);
		expect(resolvedEnvelopes[0].metadata.version).toEqual(envelopeAccountB.metadata.version);

		expect(resolvedEnvelopes[1].payload).toEqual(envelopeAccountA.payload);
		expect(resolvedEnvelopes[1].metadata.aggregateId).toEqual(envelopeAccountA.metadata.aggregateId);
		expect(resolvedEnvelopes[1].metadata.registeredOn).toBeInstanceOf(Date);
		expect(resolvedEnvelopes[1].metadata.version).toEqual(envelopeAccountA.metadata.version);
	});
});
