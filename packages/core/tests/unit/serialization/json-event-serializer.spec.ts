import {
	Event,
	EventMap,
	EventSerializationException,
	EventSourcingErrorCode,
	EventStream,
	InMemoryEventStore,
	JsonEventSerializer,
	isEventSourcingError,
} from '@ocoda/event-sourcing';
import { Account, AccountId, createTestContext } from '@ocoda/event-sourcing-testing/unit';
import { createStubStore } from '../event-store/stub-event-store.js';

@Event('member-joined')
class MemberJoined {
	constructor(
		public readonly name: string,
		public readonly joinedOn: Date,
		public readonly roles: Set<string>,
		public readonly settings: Map<string, unknown>,
		public readonly team?: { name: string; members: unknown[] },
	) {}
}

const rejectionOf = (action: () => unknown): unknown => {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error('expected an exception');
};

describe(JsonEventSerializer, () => {
	const serializer = JsonEventSerializer.for(MemberJoined);
	const joinedOn = new Date('2024-02-03T04:05:06.007Z');

	it('serializes an event into plain values and back into an instance of its class', () => {
		const event = new MemberJoined('Leela', joinedOn, new Set(['captain']), new Map([['theme', 'dark']]));

		const payload = serializer.serialize(event);
		expect(payload).toStrictEqual({
			name: 'Leela',
			joinedOn,
			roles: ['captain'],
			settings: { theme: 'dark' },
			team: undefined,
		});
		expect(payload.joinedOn).not.toBe(joinedOn);

		const read = serializer.deserialize(JSON.parse(JSON.stringify(payload)));
		expect(read).toBeInstanceOf(MemberJoined);
		expect(read).toStrictEqual(
			Object.assign(Object.create(MemberJoined.prototype), {
				name: 'Leela',
				joinedOn: joinedOn.toISOString(),
				roles: ['captain'],
				settings: { theme: 'dark' },
				team: undefined,
			}),
		);
	});

	it('names the property that closes a circular reference', () => {
		const team = { name: 'Planet Express', members: [] as unknown[] };
		const event = new MemberJoined('Fry', joinedOn, new Set(), new Map(), team);
		team.members.push({ name: 'Fry', team });

		const error = rejectionOf(() => serializer.serialize(event));

		expect(error).toBeInstanceOf(EventSerializationException);
		expect(isEventSourcingError(error, EventSourcingErrorCode.EventSerialization)).toBe(true);
		expect(error).toMatchObject({
			code: 'ES_EVENT_SERIALIZATION',
			event: 'MemberJoined',
			reason: 'circular-reference',
			path: 'team.members[0].team',
		});
		expect((error as Error).message).toBe(
			'Cannot serialize the event MemberJoined: team.members[0].team refers back to an object that contains it (a circular reference). An event payload must be a tree.',
		);
	});

	it('finds circular references through maps, sets and odd keys', () => {
		const settings = new Map<string, unknown>();
		settings.set('odd key', new Set([settings]));
		const event = new MemberJoined('Bender', joinedOn, new Set(), settings);

		expect(rejectionOf(() => serializer.serialize(event))).toMatchObject({
			path: 'settings["odd key"][0]',
		});

		const roles = new Set<unknown>();
		roles.add([roles]);
		expect(
			rejectionOf(() => serializer.serialize(new MemberJoined('Amy', joinedOn, roles as Set<string>, new Map()))),
		).toMatchObject({ path: 'roles[0][0]' });
	});

	it('serializes an object that is referenced twice, but not in a cycle', () => {
		const shared = { name: 'shared', members: [] };
		const event = new MemberJoined('Zoidberg', joinedOn, new Set(), new Map([['a', shared]]), shared);

		const payload = serializer.serialize(event);

		expect(payload.team).toStrictEqual(shared);
		expect(payload.settings).toStrictEqual({ a: shared });
		expect(payload.team).not.toBe(payload.settings.a);
	});

	it('fails an append with a circular reference before any I/O', async () => {
		const { store, publishAll, eventMap } = createStubStore();
		eventMap.register(MemberJoined, JsonEventSerializer.for(MemberJoined));
		const team = { name: 'Planet Express', members: [] as unknown[] };
		team.members.push(team);

		await expect(
			store.appendEvents(
				EventStream.for(Account, AccountId.generate()),
				[new MemberJoined('Hermes', joinedOn, new Set(), new Map(), team)],
				{ expectedVersion: 0 },
			),
		).rejects.toMatchObject({ code: 'ES_EVENT_SERIALIZATION', path: 'team.members[0]' });
		expect(store.headReads).toEqual([]);
		expect(store.persisted).toEqual([]);
		expect(publishAll).not.toHaveBeenCalled();
	});

	it('is the serializer of the in-memory store round trip', async () => {
		const eventMap = new EventMap();
		eventMap.register(MemberJoined, JsonEventSerializer.for(MemberJoined));
		const store = new InMemoryEventStore({ ...createTestContext(), eventMap }, { driver: InMemoryEventStore });
		await store.connect();
		await store.ensureCollection();
		const stream = EventStream.for(Account, AccountId.generate());
		const event = new MemberJoined('Nibbler', joinedOn, new Set(['pet']), new Map([['size', 1]]));

		await store.appendEvents(stream, [event], { expectedVersion: 0 });
		const read = (await store.getEvent(stream, 1)) as MemberJoined;

		expect(read).toBeInstanceOf(MemberJoined);
		expect(read).toMatchObject({ name: 'Nibbler', roles: ['pet'], settings: { size: 1 } });
		expect(read.joinedOn).toStrictEqual(joinedOn);
		expect(read.joinedOn).not.toBe(event.joinedOn);
	});

	it('can be constructed by subclasses', () => {
		class LoggingSerializer extends JsonEventSerializer<MemberJoined> {
			constructor() {
				super(MemberJoined);
			}
		}

		const read = new LoggingSerializer().deserialize({ name: 'Scruffy' } as never);

		expect(read).toBeInstanceOf(MemberJoined);
		expect(read.name).toBe('Scruffy');
	});
});

describe(EventSerializationException, () => {
	it('describes class-transformer decorators and the fix', () => {
		const error = new EventSerializationException({
			event: 'FundsDeposited',
			reason: 'class-transformer-decorators',
			decorators: ['@Type on FundsDeposited.amount'],
		});

		expect(error.decorators).toEqual(['@Type on FundsDeposited.amount']);
		expect(error.message).toBe(
			"The event FundsDeposited uses class-transformer decorators (@Type on FundsDeposited.amount), which the default JsonEventSerializer ignores. Serialize it with class-transformer: set defaultEventSerializer: ClassTransformerEventSerializer (from '@ocoda/event-sourcing/class-transformer') in EventSourcingModule.forRoot(), or register an @EventSerializer() for the event.",
		);
	});

	it('has a message without details', () => {
		expect(new EventSerializationException(undefined as never).message).toBe('Cannot serialize the event unknown.');
		expect(new EventSerializationException({ event: 'E', reason: 'class-transformer-decorators' }).message).toContain(
			'(unknown)',
		);
		expect(new EventSerializationException({ event: 'E', reason: 'circular-reference' }).message).toContain(
			'a property refers back',
		);
	});
});
