import { Provider } from '@nestjs/common';
import { EVENT_SOURCING_OPTIONS } from './constants';
import { EventMap } from './event-map';
import { EventStore } from './event-store';
import { InMemoryEventStore } from './integration/event-store';
import { InMemorySnapshotStore } from './integration/snapshot-store';
import { EventSourcingModuleOptions } from './interfaces';
import { SnapshotStore } from './snapshot-store';

export function createEventSourcingProviders<TOptions extends Record<string, any> = EventSourcingModuleOptions>(
	options: TOptions,
): Provider[] {
	return [{ provide: EVENT_SOURCING_OPTIONS, useValue: options }];
}

export const EventStoreProvider = {
	provide: EventStore,
	useFactory: async (eventMap: EventMap, { eventStore }: EventSourcingModuleOptions) => {
		const { driver, ...config } = eventStore ?? { driver: InMemoryEventStore };
		return new driver(eventMap, config);
	},
	inject: [EventMap, EVENT_SOURCING_OPTIONS],
};

export const SnapshotStoreProvider = {
	provide: SnapshotStore,
	useFactory: async ({ snapshotStore }: EventSourcingModuleOptions) => {
		const { driver, ...config } = snapshotStore ?? { driver: InMemorySnapshotStore };
		return new driver(config);
	},
	inject: [EVENT_SOURCING_OPTIONS],
};

/**
 * A utility function for getting the options injection token
 */
export const getOptionsToken = () => EVENT_SOURCING_OPTIONS;
