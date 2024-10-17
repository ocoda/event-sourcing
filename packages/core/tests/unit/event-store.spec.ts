import {
	Aggregate,
	type EventEnvelope,
	EventMap,
	EventStore,
	type IEvent,
	type IEventCollection,
	type IEventCollectionFilter,
	type IEventPool,
} from '@ocoda/event-sourcing';

describe(EventStore, () => {
	@Aggregate()
	class FooEventStore extends EventStore {
		public connect(): void | Promise<void> {}
		public disconnect(): void | Promise<void> {}
		public ensureCollection(pool?: IEventPool): IEventCollection | Promise<IEventCollection> {
			return;
		}
		public listCollections(filter?: IEventCollectionFilter): AsyncGenerator<IEventCollection[]> {
			return;
		}
		getEvent(): IEvent | Promise<IEvent> {
			return;
		}
		getEvents(): AsyncGenerator<IEvent[]> {
			return;
		}
		appendEvents(): Promise<EventEnvelope[]> {
			return;
		}
		getEnvelopes?(): AsyncGenerator<EventEnvelope[]> {
			return;
		}
		getEnvelope?(): EventEnvelope | Promise<EventEnvelope> {
			return;
		}
		getAllEnvelopes(): AsyncGenerator<EventEnvelope[]> {
			return;
		}
		getYearMonthRange(
			sinceDate: { year: number; month: number },
			untilDate?: { year: number; month: number },
		): string[] {
			return super.getYearMonthRange(sinceDate, untilDate);
		}
	}

	const eventStore = new FooEventStore(new EventMap(), { useDefaultPool: false });

	it('should calculate yearMonth values between two dates', () => {
		expect(eventStore.getYearMonthRange({ year: 2021, month: 1 }, { year: 2021, month: 3 })).toEqual([
			'2021-01',
			'2021-02',
			'2021-03',
		]);
	});
});
