import { BadRequestException, Controller, DefaultValuePipe, Get, ParseIntPipe, Query } from '@nestjs/common';
import { type EventEnvelope, EventStore } from '@ocoda/event-sourcing';

export interface EventLogEntry {
	/** The global position: a bigint, sent as a string because JSON numbers can't hold every bigint. */
	position: string;
	eventId: string;
	event: string;
	aggregateId: string;
	version: number;
	occurredOn: string;
	payload: Record<string, unknown>;
}

export interface EventLogPage {
	events: EventLogEntry[];
	/** The position to read the next page from. */
	next: string;
}

const toEntry = ({ event, payload, metadata }: EventEnvelope): EventLogEntry => ({
	position: String(metadata.globalPosition),
	eventId: metadata.eventId.value,
	event,
	aggregateId: metadata.aggregateId,
	version: metadata.version,
	occurredOn: metadata.occurredOn.toISOString(),
	payload,
});

/**
 * The events of every stream, in the order in which they were stored. A consumer reads a page, processes it, stores
 * `next` as its checkpoint and later reads on from there, without missing an event: PostgreSQL's positions are
 * gap-safe.
 */
@Controller('events')
export class EventLogController {
	constructor(private readonly eventStore: EventStore) {}

	@Get()
	async read(
		@Query('from', new DefaultValuePipe('1')) from: string,
		@Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
	): Promise<EventLogPage> {
		if (!/^\d+$/.test(from)) {
			throw new BadRequestException('from must be a global position (a non-negative integer)');
		}
		if (limit < 1 || limit > 1000) {
			throw new BadRequestException('limit must be between 1 and 1000');
		}

		// readAll yields the events in batches of `limit`: the first batch is the page. Leaving the loop early releases
		// the reader.
		for await (const envelopes of this.eventStore.readAll({ fromPosition: BigInt(from), batch: limit })) {
			const entries = envelopes.map(toEntry);
			const last = envelopes.at(-1)?.metadata.globalPosition;
			return { events: entries, next: last === undefined ? from : (last + 1n).toString() };
		}

		return { events: [], next: from };
	}
}
