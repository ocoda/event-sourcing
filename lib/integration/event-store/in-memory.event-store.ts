import { EventStream, EventEnvelope, Id } from '../../models';
import { EventStore } from '../../event-store';
import { StreamReadingDirection } from '../../constants';
import { EventNotFoundException } from '../../exceptions';
import { EventMap } from '../../event-map';
import { IEvent } from '../../interfaces';
import { Type } from "@nestjs/common";

export class InMemoryEventStore extends EventStore {
	private eventCollection: Map<string, EventEnvelope[]> = new Map();

	constructor(readonly eventMap: EventMap) {
		super();
	}

	getEvents(
		{ name }: EventStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): IEvent[] {
		let envelopes = this.eventCollection.get(name) || [];

		if (fromVersion) {
			const startEventIndex = envelopes.findIndex(({ metadata }) => metadata.sequence === fromVersion);
			envelopes = startEventIndex === -1 ? [] : envelopes.slice(startEventIndex);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			envelopes = envelopes.reverse();
		}

		return envelopes.map(({ eventName, payload }) => this.eventMap.deserializeEvent(eventName, payload));
	}

	getEvent({ name }: EventStream, version: number): IEvent {
		const envelope = this.eventCollection.get(name)?.find(({ metadata }) => metadata.sequence === version);

		if (!envelope) {
			throw EventNotFoundException.withVersion(name, version);
		}

		return this.eventMap.deserializeEvent(envelope.eventName, envelope.payload);
	}

	appendEvents(aggregateId: Id, aggregateVersion: number, { name }: EventStream, events: IEvent[]): void {
		const existingEnvelopes = this.eventCollection.get(name) || [];

		let sequence = aggregateVersion - events.length + 1;
		const envelopes = events.reduce<EventEnvelope[]>((acc, event) => {
			const name = this.eventMap.getName(event);
			const payload = this.eventMap.serializeEvent(event);
			const envelope = EventEnvelope.new(aggregateId, sequence++, name, payload);
			return [...acc, envelope];
		}, []);

		this.eventCollection.set(name, [...existingEnvelopes,...envelopes]);
	}

	getEnvelopes(
		{ name }: EventStream,
		fromVersion?: number,
		direction: StreamReadingDirection = StreamReadingDirection.FORWARD,
	): EventEnvelope[] {
		let envelopes = this.eventCollection.get(name) || [];

		if (fromVersion) {
			const startEventIndex = envelopes.findIndex(({ metadata }) => metadata.sequence === fromVersion);
			envelopes = startEventIndex === -1 ? [] : envelopes.slice(startEventIndex);
		}

		if (direction === StreamReadingDirection.BACKWARD) {
			envelopes = envelopes.reverse();
		}

		return envelopes;
	}

	getEnvelope({ name }: EventStream, version: number): EventEnvelope {
		const envelope = this.eventCollection.get(name)?.find(({ metadata }) => metadata.sequence === version);

		if (!envelope) {
			throw EventNotFoundException.withVersion(name, version);
		}

		return envelope;
	}
}
