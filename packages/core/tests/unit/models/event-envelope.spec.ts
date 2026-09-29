import { EventEnvelope, EventId, type IEvent, UUID } from '@ocoda/event-sourcing';

describe(EventEnvelope, () => {
	class FooId extends UUID {}
	class FooCreatedEvent implements IEvent {
		constructor(public readonly bar: string) {}
	}

	it('should create an event-envelope', () => {
		const fooId = FooId.generate();
		const fooCreatedEvent = new FooCreatedEvent('bar');

		const envelope = EventEnvelope.create('foo-created', Object.assign({}, fooCreatedEvent), {
			aggregateId: fooId.value,
			version: 1,
		});

		expect(envelope.event).toBe('foo-created');
		expect(envelope.payload).toEqual({ bar: 'bar' });
		expect(envelope.metadata.aggregateId).toEqual(fooId.value);
		expect(envelope.metadata.eventId).toBeInstanceOf(EventId);
		expect(envelope.metadata.version).toBe(1);
		expect(envelope.metadata.occurredOn).toBeInstanceOf(Date);
	});

	describe('create', () => {
		it('generates an event id when eventId is given as undefined', () => {
			// 3.x spread the metadata last, so an explicit undefined replaced the generated id
			const envelope = EventEnvelope.create('foo-created', {}, { aggregateId: 'a', version: 1, eventId: undefined });

			expect(envelope.metadata.eventId).toBeInstanceOf(EventId);
			expect(envelope.metadata.occurredOn).toEqual(envelope.metadata.eventId.date);
		});

		it('keeps a given event id, and takes occurredOn from it', () => {
			const eventId = EventId.generate(new Date('2024-02-29T12:00:00.000Z'));

			const envelope = EventEnvelope.create('foo-created', {}, { aggregateId: 'a', version: 1, eventId });

			expect(envelope.metadata.eventId).toBe(eventId);
			expect(envelope.metadata.occurredOn).toEqual(new Date('2024-02-29T12:00:00.000Z'));
		});

		it('keeps a given occurredOn, and takes it from the event id when it is undefined', () => {
			const occurredOn = new Date('2020-01-01T00:00:00.123Z');
			const eventId = EventId.generate(new Date('2024-02-29T12:00:00.000Z'));

			expect(
				EventEnvelope.create('foo-created', {}, { aggregateId: 'a', version: 1, eventId, occurredOn }).metadata
					.occurredOn,
			).toBe(occurredOn);
			expect(
				EventEnvelope.create('foo-created', {}, { aggregateId: 'a', version: 1, eventId, occurredOn: undefined })
					.metadata.occurredOn,
			).toEqual(eventId.date);
		});

		it('keeps the other metadata', () => {
			const envelope = EventEnvelope.create(
				'foo-created',
				{},
				{
					aggregateId: 'a',
					version: 3,
					correlationId: 'correlation',
					causationId: 'causation',
					headers: { tenant: 'acme' },
					eventVersion: 2,
				},
			);

			expect(envelope.metadata).toMatchObject({
				aggregateId: 'a',
				version: 3,
				correlationId: 'correlation',
				causationId: 'causation',
				headers: { tenant: 'acme' },
				eventVersion: 2,
			});
			expect(Object.keys(envelope.metadata).slice(0, 2)).toEqual(['eventId', 'occurredOn']);
		});
	});

	describe('withGlobalPosition', () => {
		it('returns a new envelope with the position and leaves the envelope as it is', () => {
			const envelope = EventEnvelope.create('foo-created', { bar: 'bar' }, { aggregateId: 'a', version: 1 });

			const positioned = envelope.withGlobalPosition(42n);

			expect(positioned).toBeInstanceOf(EventEnvelope);
			expect(positioned).not.toBe(envelope);
			expect(positioned.metadata.globalPosition).toBe(42n);
			expect(positioned.metadata).toEqual({ ...envelope.metadata, globalPosition: 42n });
			expect(positioned.event).toBe(envelope.event);
			expect(positioned.payload).toBe(envelope.payload);
			expect(envelope.metadata.globalPosition).toBeUndefined();
			expect(envelope.metadata).not.toHaveProperty('globalPosition');
		});

		it('replaces an earlier position', () => {
			const envelope = EventEnvelope.create('foo-created', {}, { aggregateId: 'a', version: 1 }).withGlobalPosition(1n);

			expect(envelope.withGlobalPosition(2n).metadata.globalPosition).toBe(2n);
		});
	});

	describe('toJSON', () => {
		const eventId = EventId.from('01JA50F56AM0CCDBNVQW3TTWNY');

		it('renders the global position as a decimal string', () => {
			const envelope = EventEnvelope.create(
				'foo-created',
				{ bar: 'bar' },
				{ aggregateId: 'a', version: 1, eventId },
			).withGlobalPosition(9007199254740993n);

			expect(JSON.parse(JSON.stringify(envelope)).metadata.globalPosition).toBe('9007199254740993');
			expect(envelope.toJSON().metadata.globalPosition).toBe('9007199254740993');
		});

		it('renders a bigint anywhere in the envelope as a decimal string', () => {
			const envelope = EventEnvelope.create(
				'foo-created',
				{ amount: 12n, nested: [{ big: -3n }] },
				{ aggregateId: 'a', version: 1 },
			);

			expect(envelope.toJSON().payload).toEqual({ amount: '12', nested: [{ big: '-3' }] });
		});

		it('renders everything else as JSON.stringify renders a plain object with the same fields', () => {
			const envelope = EventEnvelope.create(
				'foo-created',
				{ bar: 'bar', at: new Date('2024-01-01T00:00:00.000Z'), skipped: undefined },
				{ aggregateId: 'a', version: 1, eventId, correlationId: 'c', headers: { tenant: 'acme', user: null } },
			);
			const { event, payload, metadata } = envelope;

			expect(JSON.stringify(envelope)).toBe(JSON.stringify({ event, payload, metadata }));
			expect(envelope.toJSON()).toEqual({
				event: 'foo-created',
				payload: { bar: 'bar', at: '2024-01-01T00:00:00.000Z' },
				metadata: {
					eventId: { props: { value: '01JA50F56AM0CCDBNVQW3TTWNY' } },
					occurredOn: '2024-10-14T07:56:45.642Z',
					aggregateId: 'a',
					version: 1,
					correlationId: 'c',
					headers: { tenant: 'acme', user: null },
				},
			});
		});
	});
});
