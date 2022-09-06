import { EventStream, EventEnvelope } from '../../models';
import { EventStore } from '../../event-store';
import { StreamReadingDirection } from '../../constants';

export class InMemoryEventStore extends EventStore {
	private eventCollection: Map<string, EventEnvelope[]> = new Map();

	getEvents(
		eventStream: EventStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): EventEnvelope[] {
		let events = this.eventCollection.get(eventStream.name);

		if (fromVersion) {
			const startEventIndex = events.findIndex(({ metadata }) => metadata.sequence === fromVersion);
			events = startEventIndex === -1 ? [] : events.slice(startEventIndex);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			events = events.reverse();
		}

		return events;
	}

	getEvent(eventStream: EventStream, version: number): EventEnvelope {
		return this.eventCollection.get(eventStream.name).find(({ metadata }) => metadata.sequence === version);
	}

	appendEvents(eventStream: EventStream, envelopes: EventEnvelope[]): void {
		const existingEnvelopes = this.eventCollection.get(eventStream.name) || [];
		this.eventCollection.set(eventStream.name, [...existingEnvelopes, ...envelopes]);
	}
}
