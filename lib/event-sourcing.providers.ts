import { Provider } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MongoClient } from 'mongodb';
import { EVENT_SOURCING_OPTIONS } from './constants';
import { EventMap } from './event-map';
import { EventStore } from './event-store';
import { MissingEventStoreConnectionOptionsException } from './exceptions';
import { InMemoryEventStore, MongoDBEventStore } from './integration/event-store';
import { InMemorySnapshotStore, MongoDBSnapshotStore } from './integration/snapshot-store';
import { EventSourcingModuleOptions } from './interfaces';
import { SnapshotStore } from './snapshot-store';

export function createEventSourcingProviders(options: EventSourcingModuleOptions): Provider[] {
	return [{ provide: EVENT_SOURCING_OPTIONS, useValue: options }];
}

export const EventStoreProvider = {
	provide: EventStore,
	useFactory: async (eventMap: EventMap, eventEmitter: EventEmitter2, options: EventSourcingModuleOptions) => {
		switch (options.eventStore?.client) {
			case 'mongodb': {
				if (!options.eventStore.options) {
					throw new MissingEventStoreConnectionOptionsException('eventStore', 'mongodb');
				}
				const { url, ...clientOptions } = options.eventStore.options;
				const mongoClient = await new MongoClient(url, clientOptions).connect();
				return new MongoDBEventStore(eventMap, eventEmitter, mongoClient.db());
			}
			case 'in-memory':
			default:
				return new InMemoryEventStore(eventMap, eventEmitter);
		}
	},
	inject: [EventMap, EventEmitter2, EVENT_SOURCING_OPTIONS],
};

export const SnapshotStoreProvider = {
	provide: SnapshotStore,
	useFactory: async (options: EventSourcingModuleOptions) => {
		switch (options.snapshotStore?.client) {
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
