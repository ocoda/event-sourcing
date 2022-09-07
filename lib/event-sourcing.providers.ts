import { Provider } from '@nestjs/common';
import { MongoClient } from 'mongodb';
import { CommandBus } from './command-bus';
import { EVENT_SOURCING_OPTIONS } from './constants';
import { EventMap } from './event-map';
import { EventPublisher } from './event-publisher';
import { EventStore } from './event-store';
import { HandlersLoader } from './handlers.loader';
import { InMemoryEventStore, MongoDBEventStore } from './integration/event-store';
import { InMemorySnapshotStore } from './integration/snapshot-store';
import { MongoDBSnapshotStore } from './integration/snapshot-store/mongodb.snapshot-store';
import { EventSourcingModuleOptions } from './interfaces';
import { QueryBus } from './query-bus';
import { SnapshotStore } from './snapshot-store';

export function createEventSourcingProviders(options: EventSourcingModuleOptions): Provider[] {
	return [{ provide: EVENT_SOURCING_OPTIONS, useValue: options }];
}

export const EventStoreProvider = {
	provide: EventStore,
	useFactory: async (options: EventSourcingModuleOptions) => {
		switch (options.database) {
			case 'mongodb':
				const { db } = await new MongoClient(options.url).connect();
				return new MongoDBEventStore(db());
			case 'in-memory':
			default:
				return new InMemoryEventStore();
		}
	},
	inject: [EVENT_SOURCING_OPTIONS],
};

export const SnapshotStoreProvider = {
	provide: SnapshotStore,
	useFactory: async (options: EventSourcingModuleOptions) => {
		switch (options.database) {
			case 'mongodb':
				const { db } = await new MongoClient(options.url).connect();
				return new MongoDBSnapshotStore(db());
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
