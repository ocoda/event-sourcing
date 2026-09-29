import { InMemorySnapshotStore, SnapshotStore, UnsupportedOperationException } from '@ocoda/event-sourcing';
import { keepsSnapshotStoreDefault } from '../../../lib/testing/snapshot-store.conformance.js';

// The snapshot store suite skips the cases of getLastEnvelopesForAggregate for a store that keeps the default of the
// SnapshotStore base class, which rejects every read with an UnsupportedOperationException.

describe(keepsSnapshotStoreDefault, () => {
	it('is false for a store that implements the read', () => {
		expect(
			keepsSnapshotStoreDefault(
				new InMemorySnapshotStore({ driver: InMemorySnapshotStore }),
				'getLastEnvelopesForAggregate',
			),
		).toBe(false);
	});

	it('is true for a store that inherits or assigns the default', async () => {
		class Inheriting extends InMemorySnapshotStore {}
		Object.defineProperty(Inheriting.prototype, 'getLastEnvelopesForAggregate', {
			value: SnapshotStore.prototype.getLastEnvelopesForAggregate,
		});
		const inheriting = new Inheriting({ driver: InMemorySnapshotStore });

		expect(keepsSnapshotStoreDefault(inheriting, 'getLastEnvelopesForAggregate')).toBe(true);
		expect(keepsSnapshotStoreDefault(Object.create(SnapshotStore.prototype), 'getLastEnvelopesForAggregate')).toBe(
			true,
		);
		// The default the cases would otherwise fail on
		await expect(inheriting.getLastEnvelopesForAggregate(InMemorySnapshotStore as never).next()).rejects.toThrow(
			UnsupportedOperationException,
		);
	});

	it('recognizes the base class of another copy of the package by its name', () => {
		// A SnapshotStore class that isn't the one the suite imports, like one of a second copy of the package
		const OtherCopy = class SnapshotStore {
			async *getLastEnvelopesForAggregate(): AsyncGenerator<never[]> {
				yield [];
			}
		};
		class KeepsDefault extends OtherCopy {}
		class Implements extends OtherCopy {
			override async *getLastEnvelopesForAggregate(): AsyncGenerator<never[]> {
				yield [];
			}
		}
		class NotAStore {
			async *getLastEnvelopesForAggregate(): AsyncGenerator<never[]> {
				yield [];
			}
		}

		expect(keepsSnapshotStoreDefault(new KeepsDefault(), 'getLastEnvelopesForAggregate')).toBe(true);
		expect(keepsSnapshotStoreDefault(new Implements(), 'getLastEnvelopesForAggregate')).toBe(false);
		expect(keepsSnapshotStoreDefault(new NotAStore(), 'getLastEnvelopesForAggregate')).toBe(false);
		expect(keepsSnapshotStoreDefault({}, 'getLastEnvelopesForAggregate')).toBe(false);
	});
});
