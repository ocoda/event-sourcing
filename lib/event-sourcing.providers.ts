import { Client } from '@elastic/elasticsearch';
import { Provider } from '@nestjs/common';
import { MongoClient } from 'mongodb';
import { EVENT_SOURCING_OPTIONS } from './constants';
import { EventMap } from './event-map';
import { EventStore } from './event-store';
import { MissingEventStoreConnectionOptionsException } from './exceptions';
import { ElasticsearchEventStore, InMemoryEventStore, MongoDBEventStore } from './integration/event-store';
import { InMemorySnapshotStore } from './integration/snapshot-store';
import { ElasticsearchSnapshotStore } from './integration/snapshot-store/elasticsearch.snapshot-store';
import { MongoDBSnapshotStore } from './integration/snapshot-store/mongodb.snapshot-store';
import { EventSourcingModuleOptions } from './interfaces';
import { SnapshotStore } from './snapshot-store';

export function createEventSourcingProviders(options: EventSourcingModuleOptions): Provider[] {
	return [{ provide: EVENT_SOURCING_OPTIONS, useValue: options }];
}

export const EventStoreProvider = {
	provide: EventStore,
	useFactory: async (eventMap: EventMap, options: EventSourcingModuleOptions) => {
		switch (options.eventStore?.client) {
			case 'elasticsearch': {
				if (!options.eventStore.options) {
					throw new MissingEventStoreConnectionOptionsException('eventStore', 'elasticsearch');
				}
				const elasticClient = await new Client(options.eventStore.options);
				return new ElasticsearchEventStore(eventMap, elasticClient);
			}
			case 'mongodb': {
				if (!options.eventStore.options) {
					throw new MissingEventStoreConnectionOptionsException('eventStore', 'mongodb');
				}
				const { url, ...clientOptions } = options.eventStore.options;
				const mongoClient = await new MongoClient(url, clientOptions).connect();
				return new MongoDBEventStore(eventMap, mongoClient.db());
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
			case 'elasticsearch': {
				if (!options.snapshotStore.options) {
					throw new MissingEventStoreConnectionOptionsException('snapshotStore', 'elasticsearch');
				}
				const elasticClient = await new Client(options.snapshotStore.options);
				return new ElasticsearchSnapshotStore(elasticClient);
			}
			case 'mongodb': {
				if (!options.snapshotStore.options) {
					throw new MissingEventStoreConnectionOptionsException('snapshotStore', 'mongodb');
				}
				const { url, ...clientOptions } = options.snapshotStore.options;
				const mongoClient = await new MongoClient(url, clientOptions).connect();
				return new MongoDBSnapshotStore(mongoClient.db());
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
