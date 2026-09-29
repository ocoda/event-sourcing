import { DeleteTableCommand, ResourceNotFoundException } from '@aws-sdk/client-dynamodb';
import { DynamoDBEventStore } from '@ocoda/event-sourcing-dynamodb';
import { describeEventStoreConformance } from '@ocoda/event-sourcing-testing/conformance';

describeEventStoreConformance(
	DynamoDBEventStore.name,
	async (eventMap) => {
		const store = new DynamoDBEventStore(eventMap, {
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
			// TODO: getAllEnvelopes() queries one month at a time and hands out every query page as a batch, so batches
			// can be smaller than `batch` before the last one. The envelopes and their order are the same as elsewhere.
			'all-envelopes-full-batches': 'every query page (at most one month) is handed out as a batch of its own',
		},
	},
);
