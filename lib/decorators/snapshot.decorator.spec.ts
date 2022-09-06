import { SnapshotMetadata } from '../interfaces';
import { Aggregate } from '../models';
import { SNAPSHOT_METADATA } from './constants';
import { Snapshot } from './snapshot.decorator';

describe('@Snapshot', () => {
	class Account extends Aggregate {}

	it('should add snapshot metadata to the handler', () => {
		@Snapshot(Account, { name: "foo", interval: 20 })
		class AccountSnapshotHandler {}

		const { aggregate, name, interval }: SnapshotMetadata = Reflect.getMetadata(
			SNAPSHOT_METADATA,
			AccountSnapshotHandler,
		);
		expect(aggregate).toEqual(Account);
		expect(name).toEqual('foo');
		expect(interval).toEqual(20);
	});

	it('should add default snapshot metadata to the handler', () => {
		@Snapshot(Account)
		class AccountSnapshotHandler {}

		const { aggregate, name, interval }: SnapshotMetadata = Reflect.getMetadata(
			SNAPSHOT_METADATA,
			AccountSnapshotHandler,
		);
		expect(aggregate).toEqual(Account);
		expect(name).toEqual('account');
		expect(interval).toEqual(10);
	});
});
