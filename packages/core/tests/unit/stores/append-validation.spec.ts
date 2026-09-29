import {
	Aggregate,
	AggregateRoot,
	EVENT_STORE_LIMITS,
	EventEnvelope,
	EventId,
	EventStream,
	ExpectedVersion,
	Id,
	InvalidAppendOptionsException,
	InvalidEventEnvelopeException,
	InvalidEventMetadataException,
	UnsupportedOperationException,
} from '@ocoda/event-sourcing';
import {
	validateAppendMetadata,
	validateEnvelopeLimits,
	validateExpectedVersion,
	validatePool,
	validatePrebuiltEnvelopes,
} from '../../../lib/stores/append-validation.js';

@Aggregate({ streamName: 'account' })
class Account extends AggregateRoot {}

const streamOf = (aggregateId = 'a-1') => EventStream.for(Account, Id.from(aggregateId));

const envelope = (aggregateId: string, version: number, event = 'account-opened') =>
	EventEnvelope.create(event, {}, { aggregateId, version, eventId: EventId.generate() });

const headersCapable = { headers: true };

/**
 * Runs the function and returns what it threw.
 */
const thrownBy = (fn: () => unknown): unknown => {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error('expected the function to throw');
};

describe('append validation', () => {
	it('pins the limits', () => {
		expect(EVENT_STORE_LIMITS).toEqual({
			streamId: 255,
			aggregateId: 255,
			eventName: 255,
			correlationId: 255,
			causationId: 255,
			headersBytes: 8192,
		});
		expect(Object.isFrozen(EVENT_STORE_LIMITS)).toBe(true);
	});

	describe(validateExpectedVersion, () => {
		it.each([0, 1, 7, Number.MAX_SAFE_INTEGER, ExpectedVersion.NoStream, ExpectedVersion.Any])(
			'accepts %o',
			(value) => {
				expect(validateExpectedVersion(value)).toBe(value);
			},
		);

		it('normalizes -0 to 0', () => {
			expect(Object.is(validateExpectedVersion(-0), 0)).toBe(true);
		});

		it.each([
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
			'x',
			'1',
			'ANY',
			1n,
			null,
			undefined,
			{},
		])('rejects %o', (value) => {
			const error = thrownBy(() => validateExpectedVersion(value));

			expect(error).toBeInstanceOf(InvalidAppendOptionsException);
			expect(error).toMatchObject({ option: 'expectedVersion', value });
		});
	});

	describe(validatePool, () => {
		it('accepts a non-empty string, and undefined or null for the default pool', () => {
			expect(validatePool('tenant')).toBe('tenant');
			expect(validatePool(undefined)).toBeUndefined();
			expect(validatePool(null)).toBeUndefined();
		});

		it.each(['', 0, 1, true, {}, ['tenant']])('rejects %o', (value) => {
			const error = thrownBy(() => validatePool(value));

			expect(error).toBeInstanceOf(InvalidAppendOptionsException);
			expect(error).toMatchObject({ option: 'pool', value });
		});
	});

	describe(validateAppendMetadata, () => {
		it('accepts absent metadata and valid ids', () => {
			expect(() => validateAppendMetadata(undefined, undefined)).not.toThrow();
			expect(() => validateAppendMetadata(null, undefined)).not.toThrow();
			expect(() => validateAppendMetadata({}, undefined)).not.toThrow();
			expect(() =>
				validateAppendMetadata(
					{ correlationId: 'c'.repeat(255), causationId: '', headers: undefined },
					{ headers: false },
				),
			).not.toThrow();
			expect(() => validateAppendMetadata({ correlationId: null, causationId: null }, undefined)).not.toThrow();
		});

		it.each(['metadata', 1, ['correlationId']])('rejects metadata that is not an object: %o', (metadata) => {
			const error = thrownBy(() => validateAppendMetadata(metadata, headersCapable));

			expect(error).toBeInstanceOf(InvalidAppendOptionsException);
			expect(error).toMatchObject({ option: 'metadata', value: metadata });
		});

		it.each(['correlationId', 'causationId'] as const)('rejects a %s that is not a string', (field) => {
			const error = thrownBy(() => validateAppendMetadata({ [field]: 42 }, headersCapable));

			expect(error).toBeInstanceOf(InvalidEventMetadataException);
			expect(error).toMatchObject({ field, reason: 'invalid-type' });
		});

		it.each(['correlationId', 'causationId'] as const)('rejects a %s longer than 255 characters', (field) => {
			const error = thrownBy(() => validateAppendMetadata({ [field]: 'x'.repeat(256) }, headersCapable));

			expect(error).toBeInstanceOf(InvalidEventMetadataException);
			expect(error).toMatchObject({ field, reason: 'too-long', limit: 255 });
		});

		it('counts characters, not UTF-16 code units', () => {
			// 255 emoji are 510 code units, but 255 characters, which a VARCHAR(255) holds
			expect(() => validateAppendMetadata({ correlationId: '🚀'.repeat(255) }, undefined)).not.toThrow();
			expect(thrownBy(() => validateAppendMetadata({ correlationId: '🚀'.repeat(256) }, undefined))).toMatchObject({
				reason: 'too-long',
			});
		});

		describe('headers', () => {
			it('accepts strings, finite numbers, booleans and null, and unicode keys', () => {
				expect(() =>
					validateAppendMetadata(
						{ headers: { tenant: 'acme', attempt: 2, ratio: -0.5, replay: false, user: null, 'clé-東京': 'ok' } },
						headersCapable,
					),
				).not.toThrow();
				expect(() => validateAppendMetadata({ headers: Object.create(null) }, headersCapable)).not.toThrow();
			});

			it('rejects headers that are not a plain object', () => {
				for (const headers of ['tenant=acme', 1, ['acme'], new Map([['tenant', 'acme']]), new Date()]) {
					const error = thrownBy(() => validateAppendMetadata({ headers }, headersCapable));

					expect(error).toBeInstanceOf(InvalidEventMetadataException);
					expect(error).toMatchObject({ field: 'headers', reason: 'invalid-type' });
				}
			});

			it('rejects an empty key', () => {
				expect(thrownBy(() => validateAppendMetadata({ headers: { '': 'x' } }, headersCapable))).toMatchObject({
					name: 'InvalidEventMetadataException',
					field: 'headers',
					reason: 'empty-key',
					key: '',
				});
			});

			it('rejects keys that start with $, unless reserved keys are allowed', () => {
				const metadata = { headers: { $traceparent: '00-abc-def-01' } };

				expect(thrownBy(() => validateAppendMetadata(metadata, headersCapable))).toMatchObject({
					name: 'InvalidEventMetadataException',
					reason: 'reserved-key',
					key: '$traceparent',
				});
				expect(() => validateAppendMetadata(metadata, headersCapable, { allowReservedKeys: true })).not.toThrow();
				// Only a leading $ is reserved
				expect(() => validateAppendMetadata({ headers: { 'price-$': 1 } }, headersCapable)).not.toThrow();
			});

			it('still checks keys, values and size when reserved keys are allowed', () => {
				for (const [headers, reason] of [
					[{ '': 'x' }, 'empty-key'],
					[{ $k: { nested: true } }, 'invalid-value'],
					[{ $k: 'x'.repeat(8192) }, 'too-large'],
				] as const) {
					expect(
						thrownBy(() => validateAppendMetadata({ headers }, headersCapable, { allowReservedKeys: true })),
					).toMatchObject({ name: 'InvalidEventMetadataException', field: 'headers', reason });
				}
			});

			it.each([
				['an object', { nested: true }],
				['an array', ['a']],
				['NaN', Number.NaN],
				['Infinity', Number.POSITIVE_INFINITY],
				['undefined', undefined],
				['a bigint', 1n],
				['a date', new Date(0)],
				['a function', () => 1],
			])('rejects a value that is %s', (_, value) => {
				expect(thrownBy(() => validateAppendMetadata({ headers: { key: value } }, headersCapable))).toMatchObject({
					name: 'InvalidEventMetadataException',
					field: 'headers',
					reason: 'invalid-value',
					key: 'key',
				});
			});

			it('rejects headers whose JSON is larger than 8 KiB in UTF-8', () => {
				// {"k":"…"} is 8 bytes plus the value
				const fits = { k: 'x'.repeat(8192 - 8) };
				const tooLarge = { k: 'x'.repeat(8192 - 7) };
				// 'é' is 1 code unit but 2 bytes in UTF-8
				const tooLargeInBytes = { k: 'é'.repeat(4093) };

				expect(() => validateAppendMetadata({ headers: fits }, headersCapable)).not.toThrow();
				for (const headers of [tooLarge, tooLargeInBytes]) {
					expect(thrownBy(() => validateAppendMetadata({ headers }, headersCapable))).toMatchObject({
						name: 'InvalidEventMetadataException',
						field: 'headers',
						reason: 'too-large',
						limit: 8192,
					});
				}
			});

			it('rejects headers on a store without the headers capability', () => {
				for (const capabilities of [{ headers: false }, {}, undefined]) {
					const error = thrownBy(() =>
						validateAppendMetadata({ headers: { tenant: 'acme' } }, capabilities, { component: 'MongoEventStore' }),
					);

					expect(error).toBeInstanceOf(UnsupportedOperationException);
					expect(error).toMatchObject({ operation: 'headers', component: 'MongoEventStore' });
				}
				expect(thrownBy(() => validateAppendMetadata({ headers: { tenant: 'acme' } }, undefined))).toMatchObject({
					component: 'event store',
				});
			});

			it('rejects invalid headers as invalid metadata on a store without the headers capability too', () => {
				for (const [headers, reason] of [
					['tenant=acme', 'invalid-type'],
					[{ '': 'x' }, 'empty-key'],
					[{ $x: 1 }, 'reserved-key'],
					[{ a: Number.NaN }, 'invalid-value'],
					[{ k: 'x'.repeat(8192) }, 'too-large'],
				] as const) {
					for (const capabilities of [{ headers: false }, {}, undefined]) {
						expect(thrownBy(() => validateAppendMetadata({ headers }, capabilities))).toMatchObject({
							name: 'InvalidEventMetadataException',
							field: 'headers',
							reason,
						});
					}
				}
			});

			it('lets empty or absent headers through on a store without the headers capability', () => {
				expect(() => validateAppendMetadata({ headers: {} }, { headers: false })).not.toThrow();
				expect(() => validateAppendMetadata({ headers: null }, { headers: false })).not.toThrow();
			});
		});
	});

	describe(validateEnvelopeLimits, () => {
		it('accepts values of up to 255 characters', () => {
			const stream = streamOf('a'.repeat(255 - 'account-'.length));

			expect(() =>
				validateEnvelopeLimits(stream, [{ event: 'e'.repeat(255) }, { event: '東'.repeat(255) }]),
			).not.toThrow();
			expect(() => validateEnvelopeLimits(stream, [])).not.toThrow();
		});

		it('rejects a stream id longer than 255 characters', () => {
			const stream = streamOf('a'.repeat(256 - 'account-'.length));

			expect(thrownBy(() => validateEnvelopeLimits(stream, []))).toMatchObject({
				name: 'InvalidEventEnvelopeException',
				streamId: stream.streamId,
				reason: 'too-long',
				field: 'streamId',
				expected: 255,
				actual: 256,
				index: undefined,
			});
		});

		it('rejects an aggregate id longer than 255 characters', () => {
			// An aggregate id can only be too long in a stream id that is too long too, unless the stream id is
			// shorter than the aggregate id, which a stream of another shape could be.
			const stream = { streamId: 'short', aggregateId: 'a'.repeat(256) } as EventStream;

			expect(thrownBy(() => validateEnvelopeLimits(stream, []))).toMatchObject({
				reason: 'too-long',
				field: 'aggregateId',
				actual: 256,
			});
		});

		it('rejects an event name longer than 255 characters, with its index', () => {
			const error = thrownBy(() =>
				validateEnvelopeLimits(streamOf(), [{ event: 'account-opened' }, { event: 'e'.repeat(256) }]),
			);

			expect(error).toBeInstanceOf(InvalidEventEnvelopeException);
			expect(error).toMatchObject({ reason: 'too-long', field: 'event', index: 1, expected: 255, actual: 256 });
		});

		it('leaves an event name that is not a string to the serializer', () => {
			expect(() => validateEnvelopeLimits(streamOf(), [{ event: 42 as never }])).not.toThrow();
		});
	});

	describe(validatePrebuiltEnvelopes, () => {
		const stream = streamOf('a-1');

		it('accepts raw events with any expected version', () => {
			expect(() => validatePrebuiltEnvelopes(stream, [{}, {}], ExpectedVersion.Any)).not.toThrow();
			expect(() => validatePrebuiltEnvelopes(stream, [{}, {}], 3)).not.toThrow();
			expect(() => validatePrebuiltEnvelopes(stream, [], ExpectedVersion.Any)).not.toThrow();
		});

		it('accepts envelopes that continue the stream, mixed with raw events', () => {
			expect(() =>
				validatePrebuiltEnvelopes(stream, [envelope('a-1', 4), envelope('a-1', 5), envelope('a-1', 6)], 3),
			).not.toThrow();
			expect(() =>
				validatePrebuiltEnvelopes(stream, [{}, envelope('a-1', 2), {}, envelope('a-1', 4)], 0),
			).not.toThrow();
		});

		it('rejects envelopes appended with ExpectedVersion.Any', () => {
			const error = thrownBy(() => validatePrebuiltEnvelopes(stream, [{}, envelope('a-1', 2)], ExpectedVersion.Any));

			expect(error).toBeInstanceOf(InvalidEventEnvelopeException);
			expect(error).toMatchObject({ streamId: stream.streamId, index: 1, reason: 'expected-version-any' });
		});

		it('rejects an envelope of another aggregate', () => {
			expect(thrownBy(() => validatePrebuiltEnvelopes(stream, [envelope('a-2', 1)], 0))).toMatchObject({
				name: 'InvalidEventEnvelopeException',
				index: 0,
				reason: 'aggregate-id',
				expected: 'a-1',
				actual: 'a-2',
			});
		});

		it.each([
			['a gap before the first envelope', [envelope('a-1', 3)], 1, 0, 2, 3],
			['a version that was already taken', [envelope('a-1', 1)], 1, 0, 2, 1],
			['envelopes out of order', [envelope('a-1', 2), envelope('a-1', 1)], 0, 0, 1, 2],
			['a raw event where the envelope expects a gap', [{}, envelope('a-1', 3)], 0, 1, 2, 3],
			['a duplicate version', [envelope('a-1', 1), envelope('a-1', 1)], 0, 1, 2, 1],
		])('rejects %s', (_, items, expectedVersion, index, expected, actual) => {
			expect(thrownBy(() => validatePrebuiltEnvelopes(stream, items, expectedVersion))).toMatchObject({
				name: 'InvalidEventEnvelopeException',
				index,
				reason: 'version',
				expected,
				actual,
			});
		});
	});
});
