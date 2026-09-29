import type {
	AppendMetadata,
	AppendOptions,
	EnvelopePublisher,
	EventEnvelope,
	EventEnvelopeMetadata,
	EventHeaders,
	EventMap,
	EventStoreCapabilities,
	EventStoreContext,
	EventStream,
	ExpectedVersion,
	IEventCollection,
	IEventPool,
	IReadAllFilter,
	MigrationOptions,
	MigrationReport,
	PersistOutcome,
	PersistTarget,
	SchemaOptions,
} from '@ocoda/event-sourcing';

// The types of the v4 store contract, as ADR 0001 §1, §8 and §9 define them. Compile-time checks only.
describe('store contract types', () => {
	it('defines the append options (§1, §8)', () => {
		expectTypeOf<AppendOptions>().toEqualTypeOf<{
			expectedVersion: ExpectedVersion;
			pool?: IEventPool;
			metadata?: AppendMetadata;
			publish?: boolean;
		}>();
		expectTypeOf<AppendMetadata>().toEqualTypeOf<{
			correlationId?: string;
			causationId?: string;
			headers?: EventHeaders;
		}>();
		expectTypeOf<EventHeaders>().toEqualTypeOf<Readonly<Record<string, string | number | boolean | null>>>();
		// @ts-expect-error the expected version is required
		expectTypeOf<AppendOptions>().toEqualTypeOf<{ pool?: IEventPool }>();
	});

	it('defines the capabilities and the store context (§1)', () => {
		expectTypeOf<EventStoreCapabilities>().toEqualTypeOf<{
			atomicAppend?: boolean;
			headers?: boolean;
			globalOrder?: 'gap-safe' | 'best-effort';
		}>();
		expectTypeOf<EventStoreContext>().toEqualTypeOf<{
			readonly eventMap: EventMap;
			readonly publisher: EnvelopePublisher;
		}>();
		expectTypeOf<EnvelopePublisher['publishAll']>().toEqualTypeOf<
			(envelopes: readonly EventEnvelope[]) => Promise<void>
		>();
	});

	it('defines the outcome and the target of persistEvents (§1)', () => {
		expectTypeOf<PersistOutcome>().toEqualTypeOf<
			| { status: 'committed'; positions: readonly bigint[] }
			| { status: 'conflict'; actualVersion?: number; cause?: unknown }
		>();
		expectTypeOf<PersistTarget>().toEqualTypeOf<{
			stream: EventStream;
			collection: IEventCollection;
			expectedVersion: number;
			pool?: IEventPool;
		}>();
	});

	it('adds headers, the event version and the global position to the envelope metadata (§8, §9)', () => {
		expectTypeOf<EventEnvelopeMetadata['headers']>().toEqualTypeOf<EventHeaders | undefined>();
		expectTypeOf<EventEnvelopeMetadata['eventVersion']>().toEqualTypeOf<number | undefined>();
		expectTypeOf<EventEnvelopeMetadata['globalPosition']>().toEqualTypeOf<bigint | undefined>();
	});

	it('defines the readAll filter (§9)', () => {
		expectTypeOf<IReadAllFilter>().toEqualTypeOf<{ fromPosition?: bigint; batch?: number; pool?: IEventPool }>();
	});

	it('defines the migration types', () => {
		expectTypeOf<SchemaOptions>().toEqualTypeOf<{ ddl?: 'auto' | 'none' }>();
		expectTypeOf<MigrationOptions['pools']>().toEqualTypeOf<(IEventPool | undefined)[] | undefined>();
		expectTypeOf<MigrationReport['collections'][number]['from']>().toEqualTypeOf<
			'absent' | 'v1' | 'v1-partial' | 'v2'
		>();
		expectTypeOf<MigrationReport['collections'][number]['action']>().toEqualTypeOf<
			'migrate' | 'resume' | 'skip' | 'blocked'
		>();
	});
});
