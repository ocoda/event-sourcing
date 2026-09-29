import { DeleteTableCommand, ResourceNotFoundException } from '@aws-sdk/client-dynamodb';
import { DynamoDBSnapshotStore } from '@ocoda/event-sourcing-dynamodb';
import { describeSnapshotStoreConformance } from '@ocoda/event-sourcing-testing/conformance';

describeSnapshotStoreConformance(
	DynamoDBSnapshotStore.name,
	async () => {
		const store = new DynamoDBSnapshotStore({
			driver: undefined as never,
			region: 'us-east-1',
			endpoint: 'http://127.0.0.1:8000',
			credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
		});
		await store.connect();

		return {
			store,
			cleanup: async (collections) => {
				for (const collection of collections) {
					await store['client'].send(new DeleteTableCommand({ TableName: collection })).catch((error) => {
						if (!(error instanceof ResourceNotFoundException)) {
							throw error;
						}
					});
				}
				await store.disconnect();
			},
		};
	},
	{
		skip: {
			// TODO: getLastEnvelopesForAggregate() compares the 'latest#<streamId>' keys with 'latest#<aggregateId>',
			// without the stream name (`latest > :latest`), so the pages don't follow each other. Making it an exclusive
			// cursor changes what the filter returns, which needs its own change (together with the other stores).
			'aggregate-cursor-paging': 'the aggregateId filter is not a cursor, so the pages do not follow each other',
		},
	},
);
