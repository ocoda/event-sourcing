import { randomUUID } from 'node:crypto';
import { Event, EventEnvelope, EventId, type IEvent, eventFilter } from '@ocoda/event-sourcing';
import { Subject } from 'rxjs';

describe(eventFilter, () => {
	@Event('A')
	class A implements IEvent {}
	@Event('B')
	// oxlint-disable-next-line no-unused-vars -- only declared to run its decorators
	class B implements IEvent {}
	@Event('C')
	// oxlint-disable-next-line no-unused-vars -- only declared to run its decorators
	class C implements IEvent {}

	let stream: Subject<any>;
	let output: IEvent[];
	let expectedResults: IEvent[];

	beforeEach(() => {
		stream = new Subject();
		output = [];
		expectedResults = [];

		stream.pipe(eventFilter(A)).subscribe((event) => output.push(event));
	});

	it('filters all the events when none is an instance of the given types', async () => {
		stream.next(
			EventEnvelope.from(
				'B',
				{},
				{ aggregateId: randomUUID(), eventId: EventId.generate(), occurredOn: new Date(), version: 1 },
			),
		);
		stream.next(
			EventEnvelope.from(
				'C',
				{},
				{ aggregateId: randomUUID(), eventId: EventId.generate(), occurredOn: new Date(), version: 1 },
			),
		);
		stream.next(
			EventEnvelope.from(
				'B',
				{},
				{ aggregateId: randomUUID(), eventId: EventId.generate(), occurredOn: new Date(), version: 2 },
			),
		);

		expect(output).toEqual([]);
	});

	it('filters instances of events to keep those of the given types', async () => {
		expectedResults.push(
			EventEnvelope.from(
				'A',
				{},
				{ aggregateId: randomUUID(), eventId: EventId.generate(), occurredOn: new Date(), version: 1 },
			),
		);

		stream.next(
			EventEnvelope.from(
				'B',
				{},
				{ aggregateId: randomUUID(), eventId: EventId.generate(), occurredOn: new Date(), version: 1 },
			),
		);
		stream.next(expectedResults[0]);
		stream.next(new Date());

		expect(output).toEqual(expectedResults);
	});
});
