import type { Type } from '@nestjs/common';
import type { IEvent } from '../../interfaces/index.js';
import type { AggregateRoot } from '../../models/index.js';

export class MissingEventHandlerException extends Error {
	constructor(aggregate: Type<AggregateRoot>, event: Type<IEvent>) {
		super(
			`Missing event-handler exception for ${event.name} in ${aggregate.name} (missing @EventHandler(${event.name}) decorator?)`,
		);
	}
}
