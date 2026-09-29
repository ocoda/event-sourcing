// The cross-version corpus: what writer.mjs appends through 3.0.2, per database. Seeded and deterministic, except
// for the events of the repository `commit()` path, whose ids and dates 3.x generates at write time.
import { Id } from '@ocoda/event-sourcing';
import {
	Account,
	AccountClosed,
	AccountOpened,
	DocumentAttached,
	FundsDeposited,
	FundsWithdrawn,
	LEDGER_STREAM_NAME,
	LedgerEntryRecorded,
	Money,
	NoteAdded,
} from './domain.mjs';

/** The writer runs in this time zone: 3.x MariaDB `TIMESTAMP` and PostgreSQL snapshot `TIMESTAMP` values depend on it. */
export const WRITER_TIME_ZONE = 'America/New_York';

/**
 * 49 bytes: `<pool>-snapshots` still fits PostgreSQL's 63-byte identifiers, the derived index names don't, so 3.0.1
 * and later shorten them and end them with a hash (`deriveIndexName`).
 */
export const LONG_POOL = 'pool-with-a-name-close-to-the-postgres-limit-49by';

/** MariaDB only: written by a second 3.x store whose sessions create the tables with the legacy `ON UPDATE` DDL. */
export const LEGACY_POOL = 'legacy';

/** PostgreSQL only: a pool whose collections lose their indexes, like a pool that 3.0.0 created after the first one. */
export const BARE_POOL = 'bare';

/** A valid ULID in canonical form: upper-case Crockford base32, without I, L, O and U. */
export const CANONICAL_EVENT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * MariaDB legacy pool: after the writes and the flag damage, the writer moves every `registered_on` by this many
 * days with an explicit assignment (which doesn't fire `ON UPDATE`). A migration UPDATE that lets `ON UPDATE` clobber
 * the column then shows as a changed value instead of one within the same second.
 */
export const LEGACY_REGISTERED_ON_SHIFT_DAYS = -1;

/** `getAllEnvelopes` reads every month from here up to the current one. */
export const ALL_ENVELOPES_SINCE = { year: 2020, month: 1 };

const RANGE_START = Date.UTC(2021, 0, 1);
const RANGE_END = Date.UTC(2022, 2, 31, 23, 59, 59, 999);
const DAY = 24 * 60 * 60 * 1000;

/**
 * Milliseconds that several streams share (several events per millisecond), chosen on edges: the New York DST
 * switches (01:30 local happens twice on 2021-11-07), month and year ends in UTC, a New York day that is already the
 * next day in UTC, and a half second (TIMESTAMP(0) truncates or rounds it).
 */
const HOT_MILLISECONDS = [
	'2021-03-14T07:30:00.123Z',
	'2021-11-07T05:30:00.456Z',
	'2021-11-07T06:30:00.456Z',
	'2021-12-31T23:59:59.999Z',
	'2022-01-01T00:00:00.000Z',
	'2021-02-28T23:59:59.500Z',
	'2021-07-04T03:59:59.999Z',
	'2021-06-15T12:00:00.000Z',
].map((iso) => Date.parse(iso));

const NOTES = [
	'Ünïcödé: Zoë Ångström, Dvořák, Łódź',
	'日本語のメモ・中文备注・한국어 메모',
	'العربية עברית (right to left)',
	'Emoji 🧾💶🏦👩🏽‍💻 and a flag 🇧🇪',
	'Combining é vs precomposed é, zero width​space, line separator',
	'Quotes "double" \'single\' `back` \\ backslash, tab\tand newline\nend',
];

const CURRENCIES = ['EUR', 'USD', 'JPY'];

/** mulberry32: a small seeded PRNG, so every run writes the same corpus. */
const createRandom = (seed) => {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID string: 10 characters of time and 16 random ones (what `EventId.generate(date)` makes, but seeded). */
const ulid = (time, random) => {
	let timePart = '';
	for (let i = 0, rest = time; i < 10; i++, rest = Math.floor(rest / 32)) {
		timePart = CROCKFORD[rest % 32] + timePart;
	}
	let randomPart = '';
	for (let i = 0; i < 16; i++) {
		randomPart += CROCKFORD[Math.floor(random() * 32)];
	}
	return timePart + randomPart;
};

const uuid = (random) => {
	const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16));
	hex[12] = '4';
	hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
	const s = hex.join('');
	return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
};

const pick = (random, values) => values[Math.floor(random() * values.length)];

/**
 * Event times of one stream, never decreasing. A hot stream has one event on its hot millisecond, and consecutive
 * events share a millisecond now and then.
 */
const streamTimes = (random, count, hot) => {
	const gap = () => (random() < 0.15 ? 0 : Math.floor(random() * 3 * DAY) + 1);
	const times = [];
	if (hot === undefined) {
		times.push(RANGE_START + Math.floor(random() * (RANGE_END - RANGE_START - 30 * DAY)));
		while (times.length < count) times.push(times.at(-1) + gap());
		return times;
	}
	const anchor = Math.floor(count / 2);
	times[anchor] = hot;
	for (let i = anchor - 1; i >= 0; i--) times[i] = times[i + 1] - gap();
	for (let i = anchor + 1; i < count; i++) times[i] = times[i - 1] + gap();
	return times;
};

/** The next ULID in lexicographic order (what a monotonic factory returns within one millisecond). */
const incrementUlid = (id) => {
	const chars = [...id];
	for (let i = chars.length - 1; i >= 10; i--) {
		const digit = CROCKFORD.indexOf(chars[i]);
		if (digit < 31) {
			chars[i] = CROCKFORD[digit + 1];
			return chars.join('');
		}
		chars[i] = CROCKFORD[0];
	}
	throw new Error(`Cannot increment the ULID ${id}`);
};

/**
 * Event ids for the times of one stream. Ids that share a millisecond within the stream ascend with the version. 3.x
 * only guarantees that for the ids one `appendEvents` call generates itself (a monotonic factory per call):
 * pre-built envelopes (`EventId.generate(date)`, a plain `ulid()`) and separate calls in the same millisecond can have
 * a later version's id sort first. The `inverted` stream of buildCorpus covers that case.
 */
const streamEventIds = (random, times) => {
	const ids = [];
	for (const [i, time] of times.entries()) {
		const id = ulid(time, random);
		ids.push(i > 0 && time === times[i - 1] && id <= ids[i - 1] ? incrementUlid(ids[i - 1]) : id);
	}
	return ids;
};

const openedEvent = (random, aggregateId, time) =>
	new AccountOpened(
		aggregateId,
		Id.from(`owner-${uuid(random)}`),
		new Date(time),
		pick(random, [[], ['vip'], ['a', 'b']]),
	);

const followUpEvent = (random, index, isLast) => {
	if (isLast && random() < 0.3) {
		return new AccountClosed(pick(random, ['moved abroad', 'duplicate account', NOTES[0]]));
	}
	switch (Math.floor(random() * 3)) {
		case 0:
			return new FundsDeposited(
				new Money(Math.round(random() * 1_000_000) / 100, pick(random, CURRENCIES)),
				`ref-${index}`,
			);
		case 1:
			return new FundsWithdrawn(Math.round(random() * 50_000) / 100, pick(random, NOTES));
		default:
			return new NoteAdded(pick(random, NOTES));
	}
};

/** Splits a stream's envelopes into one or two `appendEvents` calls. */
const splitAppends = (random, envelopes) => {
	if (envelopes.length < 3 || random() < 0.5) return [envelopes];
	const at = 1 + Math.floor(random() * (envelopes.length - 1));
	return [envelopes.slice(0, at), envelopes.slice(at)];
};

/**
 * A stream of pre-built envelopes. `correlate` sets a correlation id on every event after the first and the previous
 * event id as the causation id.
 */
const randomStream = (random, { hot, correlate, correlationId }) => {
	const aggregateId = uuid(random);
	const count = 1 + Math.floor(random() * 7);
	const times = streamTimes(random, count, hot);
	const ids = streamEventIds(random, times);
	const envelopes = ids.map((eventId, i) => ({
		event: i === 0 ? openedEvent(random, aggregateId, times[i]) : followUpEvent(random, i, i === count - 1),
		version: i + 1,
		eventId,
		...(correlate && i > 0 ? { correlationId: correlationId ?? `correlation-${ids[0]}`, causationId: ids[i - 1] } : {}),
	}));
	return { aggregate: 'account', aggregateId, appends: splitAppends(random, envelopes) };
};

/**
 * The corpus for one database.
 *
 * - `eventPools`: per pool, the streams of pre-built envelopes (`appends`, one `appendEvents` call each) and the
 *   streams written through an aggregate's `commit()` (`commits`, each a list of changes to the aggregate). Streams
 *   flagged `gapped`, `inverted` or `caseVariant` are edge cases the manifest lists. Pools flagged `legacy` (MariaDB)
 *   are written with the legacy `ON UPDATE` DDL, pools flagged `bare` (PostgreSQL) lose their indexes.
 * - `snapshotPools`: per pool, the snapshots per stream, which stream ends up with two rows flagged latest
 *   (`duplicateLatest`) or none (`missingLatest`), and for the legacy pool `registeredOnShiftDays`.
 */
export const buildCorpus = (database) => {
	// The streams every database gets come from one sequence, the database-specific ones from another, so the shared
	// part of the corpus is the same everywhere. The edge-case streams every database gets that were added later come
	// from a third, so they didn't change the others.
	const random = createRandom(0x0c0da3);
	const edgeRandom = createRandom(0x3a0c0d);
	const sharedEdgeRandom = createRandom(0x1d5c0de);
	const sql = database !== 'mongodb';
	const eventPools = [];

	const hotQueue = [...HOT_MILLISECONDS, ...HOT_MILLISECONDS, ...HOT_MILLISECONDS];
	const poolStreams = (count) =>
		Array.from({ length: count }, (_, i) =>
			randomStream(random, {
				hot: i % 2 === 0 ? hotQueue.shift() : undefined,
				correlate: i % 4 === 1,
				correlationId: i === 5 ? `c${'x'.repeat(254)}` : undefined,
			}),
		);

	const commitStream = (pool) => {
		const aggregateId = uuid(random);
		const owner = Id.from(`owner-${uuid(random)}`);
		return {
			aggregate: 'account',
			aggregateId,
			commits: [
				() => {
					const account = Account.open(aggregateId, owner, new Date(Date.UTC(2021, 4, 5)));
					account.deposit(125.5, 'EUR', `commit-path-${pool ?? 'default'}`);
					return account;
				},
				(account) => {
					account.withdraw(20.25, NOTES[3]);
					account.deposit(1000, 'JPY', 'second commit');
					return account;
				},
			],
		};
	};

	// Default pool: random streams, edge cases and the repository commit() path.
	const defaultStreams = poolStreams(24);

	const gapped = uuid(random);
	const gappedTimes = streamTimes(random, 4);
	const gappedIds = streamEventIds(random, gappedTimes);
	defaultStreams.push({
		aggregate: 'account',
		aggregateId: gapped,
		gapped: true,
		appends: [
			[1, 2, 3, 5].map((version, i) => ({
				event:
					i === 0 ? openedEvent(random, gapped, gappedTimes[i]) : new NoteAdded(`gapped stream, version ${version}`),
				version,
				eventId: gappedIds[i],
			})),
		],
	});

	// The 120-character stream id; the envelopes carry a 36-character aggregate id (aggregate_id is 40 wide).
	const ledgerUuid = uuid(random);
	const ledgerTimes = streamTimes(random, 3);
	const ledgerIds = streamEventIds(random, ledgerTimes);
	defaultStreams.push({
		aggregate: LEDGER_STREAM_NAME,
		aggregateId: `${ledgerUuid}-${'0'.repeat(32)}`,
		envelopeAggregateId: ledgerUuid,
		appends: [
			ledgerIds.map((eventId, i) => ({
				event: new LedgerEntryRecorded(i + 1, i === 2 ? Number.MAX_SAFE_INTEGER : -i * 1.5),
				version: i + 1,
				eventId,
			})),
		],
	});

	// About 100 KB of payload.
	const document = uuid(random);
	const documentTimes = streamTimes(random, 2);
	const documentIds = streamEventIds(random, documentTimes);
	defaultStreams.push({
		aggregate: 'account',
		aggregateId: document,
		appends: [
			[
				{ event: openedEvent(random, document, documentTimes[0]), version: 1, eventId: documentIds[0] },
				{
					event: new DocumentAttached('statement.txt', `${NOTES.join(' | ')}\n`.repeat(560).slice(0, 100_000)),
					version: 2,
					eventId: documentIds[1],
				},
			],
		],
	});

	// Two appends in one millisecond whose ids sort the other way round (3.x generated each id with a plain `ulid()`):
	// 3.x `getAllEnvelopes` (`ORDER BY event_date, event_id`) lists version 2 before version 1.
	const inverted = uuid(sharedEdgeRandom);
	const invertedTime = Date.parse('2021-08-08T08:08:08.808Z');
	const [lowId, highId] = [ulid(invertedTime, sharedEdgeRandom), ulid(invertedTime, sharedEdgeRandom)].sort();
	defaultStreams.push({
		aggregate: 'account',
		aggregateId: inverted,
		inverted: true,
		appends: [
			[{ event: openedEvent(sharedEdgeRandom, inverted, invertedTime), version: 1, eventId: highId }],
			[{ event: new NoteAdded('same millisecond, its id sorts before version 1'), version: 2, eventId: lowId }],
		],
	});

	// Ids 3.x accepted (`/^[0-9a-z]{26}$/i`) that aren't canonical ULIDs: lower case, and I, L, O and U in the random
	// part. Their time part still decodes.
	const nonCanonical = uuid(sharedEdgeRandom);
	const nonCanonicalTime = Date.parse('2021-08-20T10:00:00.000Z');
	defaultStreams.push({
		aggregate: 'account',
		aggregateId: nonCanonical,
		appends: [
			[
				{
					event: openedEvent(sharedEdgeRandom, nonCanonical, nonCanonicalTime),
					version: 1,
					eventId: ulid(nonCanonicalTime, sharedEdgeRandom).toLowerCase(),
				},
				{
					event: new NoteAdded('an event id with I, L, O and U'),
					version: 2,
					eventId: `${ulid(nonCanonicalTime + 90_000, sharedEdgeRandom).slice(0, 22)}ILOU`,
				},
			],
		],
	});

	if (sql) {
		// The same event id in two streams (MongoDB keys its documents by event id, so SQL only).
		const [first, second] = [uuid(edgeRandom), uuid(edgeRandom)];
		const time = Date.parse('2021-09-09T09:09:09.090Z');
		const shared = ulid(time, edgeRandom);
		for (const aggregateId of [first, second]) {
			defaultStreams.push({
				aggregate: 'account',
				aggregateId,
				appends: [
					[
						{
							event: openedEvent(edgeRandom, aggregateId, time - DAY),
							version: 1,
							eventId: ulid(time - DAY, edgeRandom),
						},
						{ event: new NoteAdded('shares its event id with another stream'), version: 2, eventId: shared },
					],
				],
			});
		}
	}

	if (database === 'mariadb') {
		// Stream ids that differ in case only: the 3.x tables compare them case-insensitively.
		const time = Date.parse('2021-10-10T10:10:10.100Z');
		defaultStreams.push(
			{
				aggregate: 'account',
				aggregateId: 'Acc-1',
				caseVariant: true,
				appends: [[{ event: openedEvent(edgeRandom, 'Acc-1', time), version: 1, eventId: ulid(time, edgeRandom) }]],
			},
			{
				aggregate: 'account',
				aggregateId: 'acc-1',
				caseVariant: true,
				appends: [[{ event: new NoteAdded('lower-case twin'), version: 2, eventId: ulid(time + 1, edgeRandom) }]],
			},
		);
	}

	eventPools.push({
		pool: undefined,
		streams: defaultStreams,
		commitStreams: [commitStream(undefined), commitStream(undefined)],
	});
	eventPools.push({ pool: 'tenant-a', streams: poolStreams(10), commitStreams: [commitStream('tenant-a')] });
	eventPools.push({ pool: LONG_POOL, streams: poolStreams(5), commitStreams: [] });
	if (database === 'mariadb') {
		eventPools.push({ pool: LEGACY_POOL, legacy: true, streams: poolStreams(4), commitStreams: [] });
	}
	if (database === 'postgres') {
		eventPools.push({
			pool: BARE_POOL,
			bare: true,
			streams: Array.from({ length: 3 }, () => randomStream(edgeRandom, {})),
			commitStreams: [],
		});
	}

	const snapshotPayload = (stream, version) => ({
		accountId: stream.aggregateId,
		balance: version * 10.5,
		owner: NOTES[version % NOTES.length],
		openedOn: new Date(Date.UTC(2021, 0, 1, 12, 0, 0, version)),
		history: Array.from({ length: version }, (_, i) => i),
		nested: { level: { deep: version % 2 === 0, empty: {} } },
	});
	const snapshotStreams = (pool, count, versions) =>
		pool.streams.slice(0, count).map((stream) => ({
			aggregate: stream.aggregate,
			aggregateId: stream.aggregateId,
			snapshots: versions.map((version) => ({ version, payload: snapshotPayload(stream, version) })),
		}));

	const eventPool = (name) => eventPools.find(({ pool }) => pool === name);
	const snapshotPools = [
		{
			pool: undefined,
			streams: snapshotStreams(eventPool(undefined), 6, [1, 3, 5]),
			duplicateLatest: [{ streamIndex: 0, version: 3 }],
			missingLatest: [{ streamIndex: 1 }],
		},
		{
			pool: 'tenant-a',
			streams: snapshotStreams(eventPool('tenant-a'), 3, [2, 4]),
			duplicateLatest: [],
			missingLatest: [],
		},
		{
			pool: LONG_POOL,
			streams: snapshotStreams(eventPool(LONG_POOL), 2, [2, 4]),
			duplicateLatest: [],
			missingLatest: [],
		},
	];
	if (eventPool(LEGACY_POOL)) {
		// The flag repair of the migration UPDATEs these rows, where `ON UPDATE` clobbers `registered_on` unless the
		// statement assigns it (see LEGACY_REGISTERED_ON_SHIFT_DAYS).
		snapshotPools.push({
			pool: LEGACY_POOL,
			legacy: true,
			streams: snapshotStreams(eventPool(LEGACY_POOL), 3, [1, 2, 3]),
			duplicateLatest: [{ streamIndex: 0, version: 2 }],
			missingLatest: [{ streamIndex: 1 }],
			registeredOnShiftDays: LEGACY_REGISTERED_ON_SHIFT_DAYS,
		});
	}
	if (eventPool(BARE_POOL)) {
		snapshotPools.push({
			pool: BARE_POOL,
			bare: true,
			streams: snapshotStreams(eventPool(BARE_POOL), 2, [1, 2]),
			duplicateLatest: [],
			missingLatest: [],
		});
	}

	return { eventPools, snapshotPools };
};
