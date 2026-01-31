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
			return {} as IEventCollection;
		}
		public listCollections(filter?: IEventCollectionFilter): AsyncGenerator<IEventCollection[]> {
			return (async function* () {
				yield [] as IEventCollection[];
			})();
		}
		getEvent(): IEvent | Promise<IEvent> {
			return {} as IEvent;
		}
		getEvents(): AsyncGenerator<IEvent[]> {
			return (async function* () {
				yield [] as IEvent[];
			})();
		}
		appendEvents(): Promise<EventEnvelope[]> {
			return Promise.resolve([]);
		}
		getEnvelopes?(): AsyncGenerator<EventEnvelope[]> {
			return (async function* () {
				yield [] as EventEnvelope[];
			})();
		}
		getEnvelope?(): EventEnvelope | Promise<EventEnvelope> {
			return {} as EventEnvelope;
		}
		getAllEnvelopes(): AsyncGenerator<EventEnvelope[]> {
			return (async function* () {
				yield [] as EventEnvelope[];
			})();
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

	it('should calculate yearMonth values until current date when no end is supplied', () => {
		jest.useFakeTimers().setSystemTime(new Date('2024-06-15T12:00:00Z'));

		expect(eventStore.getYearMonthRange({ year: 2024, month: 4 })).toEqual(['2024-04', '2024-05', '2024-06']);

		jest.useRealTimers();
	});

	it('should return a single month when since and until are the same', () => {
		expect(eventStore.getYearMonthRange({ year: 2022, month: 7 }, { year: 2022, month: 7 })).toEqual(['2022-07']);
	});
});
