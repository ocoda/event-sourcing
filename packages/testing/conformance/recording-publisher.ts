import type { EnvelopePublisher, EventEnvelope } from '@ocoda/event-sourcing';

/**
 * The publisher of the event store conformance suite: it records the envelopes of every `publishAll` call, and can be
 * told to fail.
 */
export class RecordingPublisher implements EnvelopePublisher {
	/**
	 * The envelopes of every `publishAll` call, in the order of the calls.
	 */
	readonly calls: (readonly EventEnvelope[])[] = [];

	private failure: { error: unknown; synchronously: boolean } | undefined;

	publishAll(envelopes: readonly EventEnvelope[]): Promise<void> {
		this.calls.push([...envelopes]);
		if (!this.failure) {
			return Promise.resolve();
		}
		if (this.failure.synchronously) {
			throw this.failure.error;
		}
		return Promise.reject(this.failure.error);
	}

	/**
	 * Makes every following `publishAll` call fail with the error: by throwing (`synchronously`), or by returning a
	 * rejected promise. `failWith(undefined)` makes the calls succeed again.
	 */
	failWith(error: unknown, { synchronously = false }: { synchronously?: boolean } = {}): void {
		this.failure = error === undefined ? undefined : { error, synchronously };
	}

	/**
	 * The number of calls so far, to pass to `callsSince` later.
	 */
	mark(): number {
		return this.calls.length;
	}

	/**
	 * The envelopes of the calls made after the `mark()` that returned `mark`.
	 */
	callsSince(mark: number): (readonly EventEnvelope[])[] {
		return this.calls.slice(mark);
	}
}
