import { Provider } from '@nestjs/common';
import { EVENT_SOURCING_OPTIONS } from './constants';
import { EventMap } from './event-map';
import { EventStore } from './event-store';
import { MissingStoreConnectionOptionsException } from './exceptions';
import { InMemoryEventStore } from './integration/event-store';
import { InMemorySnapshotStore } from './integration/snapshot-store';
import { EventSourcingModuleOptions } from './interfaces';
import { SnapshotStore } from './snapshot-store';

export function createEventSourcingProviders(options: EventSourcingModuleOptions): Provider[] {
	return [{ provide: EVENT_SOURCING_OPTIONS, useValue: options }];
}

export const EventStoreProvider = {
	provide: EventStore,
	useFactory: async (eventMap: EventMap, options: EventSourcingModuleOptions) => {
		switch (options.eventStore?.client) {
			case 'mongodb': {
				if (!options.eventStore.options) {
					throw new MissingStoreConnectionOptionsException('eventStore', 'mongodb');
				}
				const { url, ...clientOptions } = options.eventStore.options;
				const [{ MongoClient }, { MongoDBEventStore }] = await Promise.all([
					import('mongodb'),
					import('./integration/event-store/mongodb.event-store'),
				]);
				const mongoClient = await new MongoClient(url, clientOptions).connect();
				return new MongoDBEventStore(eventMap, mongoClient.db());
			}
			case 'dynamodb': {
				if (!options.eventStore.options) {
					throw new MissingStoreConnectionOptionsException('eventStore', ' dynamodb');
				}
				const [{ DynamoDBClient }, { DynamoDBEventStore }] = await Promise.all([
					import('@aws-sdk/client-dynamodb'),
					import('./integration/event-store/dynamodb.event-store'),
				]);
				const dynamoClient = new DynamoDBClient(options.eventStore.options);
				return new DynamoDBEventStore(eventMap, dynamoClient);
			}
			case 'in-memory':
			default:
				return new InMemoryEventStore(eventMap);
		}
	},
	inject: [EventMap, EVENT_SOURCING_OPTIONS],
};

export const SnapshotStoreProvider = {
	provide: SnapshotStore,
	useFactory: async (options: EventSourcingModuleOptions) => {
		switch (options.snapshotStore?.client) {
			case 'mongodb': {
				if (!options.snapshotStore.options) {
					throw new MissingStoreConnectionOptionsException('snapshotStore', 'mongodb');
				}
				const { url, ...clientOptions } = options.snapshotStore.options;
				const [{ MongoClient }, { MongoDBSnapshotStore }] = await Promise.all([
					import('mongodb'),
					import('./integration/snapshot-store/mongodb.snapshot-store'),
				]);
				const mongoClient = await new MongoClient(url, clientOptions).connect();
				return new MongoDBSnapshotStore(mongoClient.db());
			}
			case 'dynamodb': {
				if (!options.snapshotStore.options) {
					throw new MissingStoreConnectionOptionsException('snapshotStore', 'dynamodb');
				}
				const [{ DynamoDBClient }, { DynamoDBSnapshotStore }] = await Promise.all([
					import('@aws-sdk/client-dynamodb'),
					import('./integration/snapshot-store/dynamodb.snapshot-store'),
				]);
				const dynamoClient = new DynamoDBClient(options.snapshotStore.options);
				return new DynamoDBSnapshotStore(dynamoClient);
			}
			case 'in-memory':
			default:
				return new InMemorySnapshotStore();
		}
	},
	inject: [EVENT_SOURCING_OPTIONS],
};

/**
 * A utility function for getting the options injection token
 */
export const getOptionsToken = () => EVENT_SOURCING_OPTIONS;
