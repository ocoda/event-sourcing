import {
	AggregateRoot,
	type ISnapshotRepository,
	SNAPSHOT_METADATA,
	Snapshot,
	type SnapshotRepositoryMetadata,
} from '@ocoda/event-sourcing';
import { getSnapshotMetadata } from '@ocoda/event-sourcing/helpers';

describe('@Snapshot', () => {
	class Account extends AggregateRoot {}

	it('should add snapshot metadata to the handler', () => {
		@Snapshot(Account, { name: 'foo', interval: 20 })
		class AccountSnapshotRepository implements ISnapshotRepository<Account> {
			serialize() {
				return {};
			}
			deserialize() {
				return new Account();
			}
		}

		const { aggregate, name, interval }: SnapshotRepositoryMetadata<Account> =
			getSnapshotMetadata(AccountSnapshotRepository);
		expect(aggregate).toEqual(Account);
		expect(name).toEqual('foo');
		expect(interval).toEqual(20);
	});

	it('should add default snapshot metadata to the handler', () => {
		@Snapshot(Account)
		class AccountSnapshotRepository {}

		const { aggregate, name, interval }: SnapshotRepositoryMetadata<Account> = Reflect.getMetadata(
			SNAPSHOT_METADATA,
			AccountSnapshotRepository,
		);
		expect(aggregate).toEqual(Account);
		expect(name).toEqual('account');
		expect(interval).toEqual(10);
	});
});
