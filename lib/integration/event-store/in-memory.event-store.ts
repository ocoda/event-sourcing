import { EventStream, EventEnvelope } from '../../models';
import { EventStore } from '../../event-store';
import { StreamReadingDirection } from '../../constants';
import { EventNotFoundException } from '../../exceptions';

export class InMemoryEventStore extends EventStore {
	private eventCollection: Map<string, EventEnvelope[]> = new Map();

	getEvents(
		{ name }: EventStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): EventEnvelope[] {
		let events = this.eventCollection.get(name) || [];

		if (fromVersion) {
			const startEventIndex = events.findIndex(({ metadata }) => metadata.sequence === fromVersion);
			events = startEventIndex === -1 ? [] : events.slice(startEventIndex);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			events = events.reverse();
		}

		return events;
	}

	getEvent({ name }: EventStream, version: number): EventEnvelope {
		const entity = this.eventCollection.get(name)?.find(({ metadata }) => metadata.sequence === version);

		if (!entity) {
			throw EventNotFoundException.withVersion(name, version);
		}

		return entity;
	}

	appendEvents({ name }: EventStream, envelopes: EventEnvelope[]): void {
		const existingEnvelopes = this.eventCollection.get(name) || [];
		this.eventCollection.set(name, [...existingEnvelopes, ...envelopes]);
	}
}
