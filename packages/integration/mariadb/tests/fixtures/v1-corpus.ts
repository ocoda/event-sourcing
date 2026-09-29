import { CROCKFORD_ALPHABET, ulidMilliseconds } from '../../lib/migration/sql.js';
import type { V1EventRow, V1SnapshotRow } from './schema-v1.js';
import { yearMonthOf } from './schema-v1.js';

/**
 * A small 3.x corpus with every case the migration treats specially, and a JavaScript reference of what the
 * migration makes of it (ADR 0002 §6, ADR 0001 D33).
 */

const HOUR = 60 * 60 * 1000;

/** A ULID with the given time and a random part made of `seed` (Crockford base32). */
export const ulidAt = (time: number, seed: string): string => {
	let timePart = '';
	for (let i = 0, rest = time; i < 10; i++, rest = Math.floor(rest / 32)) {
		timePart = CROCKFORD_ALPHABET[rest % 32] + timePart;
	}
	return `${timePart}${seed.padEnd(16, '0')}`.slice(0, 26);
};

/** `YYYY-MM-DD HH:MM:SS` of a time, truncated to the second, as the UTC wall time a TIMESTAMP(0) holds. */
export const secondsOf = (time: number): string =>
	new Date(Math.floor(time / 1000) * 1000).toISOString().slice(0, 19).replace('T', ' ');

const t0 = Date.parse('2021-03-14T07:30:00.123Z');

const row = (
	streamId: string,
	version: number,
	eventId: string,
	storedTime: number,
	extra: Partial<V1EventRow> = {},
): V1EventRow => ({
	streamId,
	version,
	event: version === 1 ? 'account-opened' : 'account-credited',
	payload: { amount: version * 10, note: 'Ünïcödé 日本語 🧾' },
	eventId,
	aggregateId: streamId.slice('account-'.length),
	occurredOn: secondsOf(storedTime),
	...extra,
});

const invertedLow = ulidAt(t0 + 5 * HOUR, 'AAAAAAAAAAAAAAAA');
const invertedHigh = ulidAt(t0 + 5 * HOUR, 'ZZZZZZZZZZZZZZZZ');
const sharedId = ulidAt(t0 + 6 * HOUR, 'SHAREDSHAREDSHAR');

/** The 3.x events of the corpus, as 3.x stored them (the server is UTC, the 3.x process in New York for some). */
export const v1Events = (): V1EventRow[] => [
	// Milliseconds truncated by TIMESTAMP(0)
	row('account-a', 1, ulidAt(t0, 'A1'), t0, { correlationId: 'corr-1' }),
	row('account-a', 2, ulidAt(t0 + 1001, 'A2'), t0 + 1001, { correlationId: 'corr-1', causationId: 'cause-1' }),
	row('account-a', 3, ulidAt(t0 + 2002, 'A3'), t0 + 2002),
	// Written by a process in New York (UTC-5 in January): the stored wall time is New York's, read as UTC
	row('account-b', 1, ulidAt(Date.parse('2021-01-10T15:00:00.250Z'), 'B1'), Date.parse('2021-01-10T10:00:00.250Z')),
	row('account-b', 2, ulidAt(Date.parse('2021-07-10T15:00:00.750Z'), 'B2'), Date.parse('2021-07-10T11:00:00.750Z')),
	// Gapped: 1, 2, 3, 5
	row('account-gap', 1, ulidAt(t0 + HOUR, 'G1'), t0 + HOUR),
	row('account-gap', 2, ulidAt(t0 + HOUR + 1, 'G2'), t0 + HOUR + 1),
	row('account-gap', 3, ulidAt(t0 + HOUR + 2, 'G3'), t0 + HOUR + 2),
	row('account-gap', 5, ulidAt(t0 + HOUR + 3, 'G5'), t0 + HOUR + 3),
	// Starts at 2
	row('account-start2', 2, ulidAt(t0 + 2 * HOUR, 'S2'), t0 + 2 * HOUR),
	row('account-start2', 3, ulidAt(t0 + 2 * HOUR + 10, 'S3'), t0 + 2 * HOUR + 10),
	// Ids that differ in case only: one stream in 3.x, two in schema v2
	row('account-Acc-1', 1, ulidAt(t0 + 3 * HOUR, 'C1'), t0 + 3 * HOUR),
	row('account-acc-1', 2, ulidAt(t0 + 3 * HOUR + 1, 'C2'), t0 + 3 * HOUR + 1),
	// Version 2's id sorts before version 1's in the same millisecond
	row('account-inv', 1, invertedHigh, t0 + 5 * HOUR),
	row('account-inv', 2, invertedLow, t0 + 5 * HOUR),
	// The same event id in two streams
	row('account-d1', 1, sharedId, t0 + 6 * HOUR),
	row('account-d2', 1, sharedId, t0 + 6 * HOUR),
	// Not a ULID: kept as stored
	row('account-k', 1, 'legacy-event-id-0000000001', t0 + 7 * HOUR, { eventDate: '2021-03' }),
	// A whole second: exact already
	row('account-e', 1, ulidAt(Date.parse('2021-04-01T00:00:00.000Z'), 'E1'), Date.parse('2021-04-01T00:00:00.000Z')),
	// A lower-case id: not canonical, but its time decodes
	row('account-lc', 1, ulidAt(t0 + 8 * HOUR + 5, 'LC').toLowerCase(), t0 + 8 * HOUR + 5),
	// I, L, O and U in the random part: not Crockford, but the time part is
	row('account-ilou', 1, `${ulidAt(t0 + 9 * HOUR + 7, '').slice(0, 22)}ILOU`, t0 + 9 * HOUR + 7),
	// One second off: no time zone explains it, kept
	row('account-off', 1, ulidAt(t0 + 10 * HOUR + 500, 'O1'), t0 + 10 * HOUR + 1500),
];

/** A 3.x row that 3.x wrote after the copy read the table (the catch-up). */
export const lateV1Event = (): V1EventRow => row('account-a', 4, ulidAt(t0 + 11 * HOUR, 'A4'), t0 + 11 * HOUR + 300);

const ULID_TIME = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{10}[0-9A-Za-z]{16}$/;
const CANONICAL = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export type Repair = 'exact' | 'precisionOnly' | 'tzShifted' | 'kept';

/** How the migration repairs the `occurred_on` of a row, and what it becomes. */
export const repairOf = (event: V1EventRow): { repair: Repair; occurredOn: string } => {
	const stored = Date.parse(`${event.occurredOn.replace(' ', 'T')}Z`) / 1000;
	const valid = ULID_TIME.test(event.eventId);
	const time = valid ? ulidMilliseconds(event.eventId) : 0;
	const difference = stored - Math.floor(time / 1000);
	const fix = valid && Math.abs(difference) <= 14 * 3600 && difference % 900 === 0;
	if (!fix) {
		return { repair: 'kept', occurredOn: new Date(stored * 1000).toISOString() };
	}
	const occurredOn = new Date(time).toISOString();
	if (difference !== 0) {
		return { repair: 'tzShifted', occurredOn };
	}
	return { repair: time % 1000 === 0 ? 'exact' : 'precisionOnly', occurredOn };
};

export const repairCounts = (events: readonly V1EventRow[]): Record<Repair, number> => {
	const counts: Record<Repair, number> = { exact: 0, precisionOnly: 0, tzShifted: 0, kept: 0 };
	for (const event of events) {
		counts[repairOf(event).repair]++;
	}
	return counts;
};

export const nonCanonicalCount = (events: readonly V1EventRow[]): number =>
	events.filter(({ eventId }) => !CANONICAL.test(eventId)).length;

/** Compares strings like a case-insensitive collation does, for ASCII. */
const compareCi = (a: string, b: string): number => {
	const [x, y] = [a.toUpperCase(), b.toUpperCase()];
	return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * The order in which the migration numbers the rows (ADR 0001 D33): rank them in 3.x's order,
 * `(event_date, event_id, stream_id, version)` in the table's (case-insensitive) collation; the key of a row is the
 * highest rank of its stream up to its version; number by `(key, version)`.
 */
export const expectedOrder = (events: readonly V1EventRow[]): V1EventRow[] => {
	const ranked = [...events].sort(
		(a, b) =>
			compareCi(a.eventDate ?? yearMonthOf(a.eventId), b.eventDate ?? yearMonthOf(b.eventId)) ||
			compareCi(a.eventId, b.eventId) ||
			compareCi(a.streamId, b.streamId) ||
			a.version - b.version,
	);
	const rank = new Map(ranked.map((event, index) => [event, index + 1]));
	const key = new Map<V1EventRow, number>();
	const streams = new Map<string, V1EventRow[]>();
	for (const event of events) {
		const stream = event.streamId.toUpperCase();
		streams.set(stream, [...(streams.get(stream) ?? []), event]);
	}
	for (const rows of streams.values()) {
		let highest = 0;
		for (const event of [...rows].sort((a, b) => a.version - b.version)) {
			highest = Math.max(highest, rank.get(event) as number);
			key.set(event, highest);
		}
	}
	return [...events].sort((a, b) => (key.get(a) as number) - (key.get(b) as number) || a.version - b.version);
};

/** The 3.x snapshots of the corpus, with the flag damage 3.x can leave. */
export const v1Snapshots = (): V1SnapshotRow[] => {
	const snapshot = (streamId: string, version: number, latest: boolean, second: number): V1SnapshotRow => ({
		streamId,
		version,
		payload: { balance: version * 10.5, note: 'Zoë 🏦' },
		snapshotId: `snap-${streamId}-${version}`,
		aggregateId: streamId.slice('account-'.length),
		registeredOn: `2021-05-0${1 + (second % 8)} 12:00:${String(second).padStart(2, '0')}`,
		aggregateName: 'account',
		latest,
	});
	return [
		// One flag on the highest version
		snapshot('account-s1', 1, false, 1),
		snapshot('account-s1', 2, false, 2),
		snapshot('account-s1', 3, true, 3),
		// Two flags
		snapshot('account-s2', 1, true, 4),
		snapshot('account-s2', 2, true, 5),
		// No flag
		snapshot('account-s3', 1, false, 6),
		snapshot('account-s3', 2, false, 7),
		// The flag on a lower version
		snapshot('account-s4', 1, true, 8),
		snapshot('account-s4', 3, false, 9),
		// Ids that differ in case only, each flagged (one stream in 3.x, whose primary key compares them ignoring case)
		snapshot('account-S5', 1, true, 10),
		snapshot('account-s5', 2, true, 11),
	];
};
