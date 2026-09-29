import { Module, type Type } from '@nestjs/common';
import type { IEvent, IEventSerializer } from '../interfaces/index.js';

/**
 * What one `EventSourcingModule.forFeature()` call registers. Each feature module provides one, and the registrar finds
 * them all through Nest's discovery, so the events belong to the application that imports the feature module rather
 * than to the process (3.x kept them in a static registry).
 * @internal Not exported from the package.
 */
export class EventSourcingFeature {
	readonly events: readonly Type<IEvent>[];
	readonly serializers: readonly Type<IEventSerializer>[];

	/**
	 * Keeps what it gets as it is, when that is not an array, so that the registrar reports it as an issue.
	 */
	constructor(events: readonly Type<IEvent>[] = [], serializers: readonly Type<IEventSerializer>[] = []) {
		this.events = Array.isArray(events) ? Object.freeze([...events]) : events;
		this.serializers = Array.isArray(serializers) ? Object.freeze([...serializers]) : serializers;
	}
}

/**
 * The module of every `forFeature()` call. Nest 12 keys dynamic modules by reference, so each call is a module of its
 * own.
 * @internal Not exported from the package.
 */
@Module({})
export class EventSourcingFeatureModule {}
