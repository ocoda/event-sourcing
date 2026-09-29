import { setTimeout as sleep } from 'node:timers/promises';
import { Logger } from '@nestjs/common';
import { ANY_MAX_ATTEMPTS, EventStream, ExpectedVersion } from '@ocoda/event-sourcing';
import { Account, AccountId, getEvents } from '@ocoda/event-sourcing-testing/unit';
import { createStubStore } from './stub-event-store.js';

// The backoff of ExpectedVersion.Any, without waiting for it: the sleeps of the template are recorded instead.
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }));

describe('EventStore.appendEvents with ExpectedVersion.Any', () => {
	beforeEach(() => {
		vi.mocked(sleep).mockClear();
		vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
	});

	it('backs off for random(0, min(100, 2 ** attempt)) ms after each conflict', async () => {
		const { store } = createStubStore();
		let conflicts = ANY_MAX_ATTEMPTS - 1;
		store.outcome = (envelopes) =>
			conflicts-- > 0
				? { status: 'conflict' }
				: { status: 'committed', positions: envelopes.map((_, index) => BigInt(index + 1)) };

		// The longest backoff random() can give
		vi.spyOn(Math, 'random').mockReturnValue(1);
		await store.appendEvents(EventStream.for(Account, AccountId.generate()), getEvents().slice(0, 1), {
			expectedVersion: ExpectedVersion.Any,
		});

		expect(store.persisted).toHaveLength(ANY_MAX_ATTEMPTS);
		expect(vi.mocked(sleep).mock.calls.map(([delay]) => delay)).toEqual([
			2, 4, 8, 16, 32, 64, 100, 100, 100, 100, 100, 100, 100, 100, 100,
		]);
	});

	it('scales the backoff with random()', async () => {
		const { store } = createStubStore();
		let conflicts = 3;
		store.outcome = (envelopes) =>
			conflicts-- > 0
				? { status: 'conflict' }
				: { status: 'committed', positions: envelopes.map((_, index) => BigInt(index + 1)) };

		vi.spyOn(Math, 'random').mockReturnValue(0.25);
		await store.appendEvents(EventStream.for(Account, AccountId.generate()), getEvents().slice(0, 1), {
			expectedVersion: ExpectedVersion.Any,
		});

		expect(vi.mocked(sleep).mock.calls.map(([delay]) => delay)).toEqual([0.5, 1, 2]);
	});
});
