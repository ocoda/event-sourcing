import { AggregateRoot, ISnapshotHandler, SNAPSHOT_METADATA, Snapshot, SnapshotMetadata } from '../../../lib';
import { getSnapshotMetadata } from '../../../lib/helpers';

describe('@Snapshot', () => {
	class Account extends AggregateRoot {}

	it('should add snapshot metadata to the handler', () => {
		@Snapshot(Account, { name: 'foo', interval: 20 })
		class AccountSnapshotHandler implements ISnapshotHandler<Account> {
			serialize() {
				return {};
			}
			deserialize() {
				return new Account();
			}
		}

		const { aggregate, name, interval }: SnapshotMetadata<Account> = getSnapshotMetadata(AccountSnapshotHandler);
		expect(aggregate).toEqual(Account);
		expect(name).toEqual('foo');
		expect(interval).toEqual(20);
	});

	it('should add default snapshot metadata to the handler', () => {
		@Snapshot(Account)
		class AccountSnapshotHandler {}

		const { aggregate, name, interval }: SnapshotMetadata<Account> = Reflect.getMetadata(
			SNAPSHOT_METADATA,
			AccountSnapshotHandler,
		);
		expect(aggregate).toEqual(Account);
		expect(name).toEqual('account');
		expect(interval).toEqual(10);
	});
});
