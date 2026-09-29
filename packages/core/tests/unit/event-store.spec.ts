import { Aggregate, EventCollection, type EventEnvelope, EventStore, type IEventCollection } from '@ocoda/event-sourcing';
import { createTestContext } from '@ocoda/event-sourcing-testing/unit';

// INTERIM(H): getYearMonthRange goes with getAllEnvelopes, before 4.0.
describe(EventStore, () => {
	@Aggregate()
	class FooEventStore extends EventStore {
		async connect(): Promise<void> {}
		async disconnect(): Promise<void> {}
		async ensureCollection(): Promise<IEventCollection> {
			return EventCollection.get();
		}
		async *listCollections(): AsyncGenerator<IEventCollection[]> {}
		async getEnvelope(): Promise<EventEnvelope> {
			return {} as EventEnvelope;
		}
		async *getEnvelopes(): AsyncGenerator<EventEnvelope[]> {}
		getYearMonthRange(
			sinceDate: { year: number; month: number },
			untilDate?: { year: number; month: number },
		): string[] {
			return super.getYearMonthRange(sinceDate, untilDate);
		}
	}

	const eventStore = new FooEventStore(createTestContext(), { useDefaultPool: false });

	it('should calculate yearMonth values between two dates', () => {
		expect(eventStore.getYearMonthRange({ year: 2021, month: 1 }, { year: 2021, month: 3 })).toEqual([
			'2021-01',
			'2021-02',
			'2021-03',
		]);
	});

	it('should calculate yearMonth values until current date when no end is supplied', () => {
		vi.useFakeTimers().setSystemTime(new Date('2024-06-15T12:00:00Z'));

		expect(eventStore.getYearMonthRange({ year: 2024, month: 4 })).toEqual(['2024-04', '2024-05', '2024-06']);

		vi.useRealTimers();
	});

	describe('in a timezone where the local month differs from the UTC month', () => {
		/**
		 * Simulates a local timezone by shifting the local date getters, the UTC getters are left untouched.
		 */
		const simulateTimezone = (offsetHours: number) => {
			const shift = (date: Date) => new Date(date.getTime() + offsetHours * 60 * 60 * 1000);
			vi.spyOn(Date.prototype, 'getFullYear').mockImplementation(function (this: Date) {
				return shift(this).getUTCFullYear();
			});
			vi.spyOn(Date.prototype, 'getMonth').mockImplementation(function (this: Date) {
				return shift(this).getUTCMonth();
			});
		};

		afterEach(() => {
			vi.restoreAllMocks();
			vi.useRealTimers();
		});

		it('includes the current UTC month when the local month is behind (UTC-10)', () => {
			vi.useFakeTimers().setSystemTime(new Date('2024-02-01T00:30:00Z'));
			simulateTimezone(-10);

			expect(eventStore.getYearMonthRange({ year: 2023, month: 12 })).toEqual(['2023-12', '2024-01', '2024-02']);
		});

		it('does not include the next month when the local month is ahead (UTC+14)', () => {
			vi.useFakeTimers().setSystemTime(new Date('2023-12-31T23:30:00Z'));
			simulateTimezone(14);

			expect(eventStore.getYearMonthRange({ year: 2023, month: 11 })).toEqual(['2023-11', '2023-12']);
		});
	});

	it('should return a single month when since and until are the same', () => {
		expect(eventStore.getYearMonthRange({ year: 2022, month: 7 }, { year: 2022, month: 7 })).toEqual(['2022-07']);
	});
});
