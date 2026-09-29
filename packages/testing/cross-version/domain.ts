import type { Type } from '@nestjs/common';
import {
	Aggregate,
	AggregateRoot,
	Event,
	EventMap,
	EventStream,
	Id,
	JsonEventSerializer,
	SnapshotStream,
} from '@ocoda/event-sourcing';
import { ClassTransformerEventSerializer } from '@ocoda/event-sourcing/class-transformer';
import { Type as TransformType } from 'class-transformer';

// The master mirror of fixtures/cross-version/v3/domain.mjs: same event names, class names, stream names and fields.
// Change both together.

export class Money {
	constructor(
		public readonly amount: number,
		public readonly currency: string,
	) {}
}

@Event('account-opened')
export class AccountOpened {
	constructor(
		public readonly accountId: string,
		/** An `Id` in 3.x; read back as the plain `{ props: { value } }`. */
		public readonly owner: unknown,
		/** A `Date` in 3.x; read back as a string from the SQL stores. */
		public readonly openedOn: Date | string,
		public readonly tags: string[],
	) {}
}

/** The `@Type`-decorated event: its `amount` is read back as a `Money` instance (ClassTransformerEventSerializer). */
@Event('funds-deposited')
export class FundsDeposited {
	@TransformType(() => Money)
	public readonly amount: Money;

	constructor(
		amount: Money,
		public readonly reference: string,
	) {
		this.amount = amount;
	}
}

@Event('funds-withdrawn')
export class FundsWithdrawn {
	constructor(
		public readonly amount: number,
		public readonly memo: string,
	) {}
}

@Event('note-added')
export class NoteAdded {
	constructor(public readonly text: string) {}
}

@Event('document-attached')
export class DocumentAttached {
	constructor(
		public readonly name: string,
		public readonly content: string,
	) {}
}

@Event('account-closed')
export class AccountClosed {
	constructor(public readonly reason: string) {}
}

@Event('ledger-entry-recorded')
export class LedgerEntryRecorded {
	constructor(
		public readonly sequence: number,
		public readonly value: number,
	) {}
}

/**
 * An event map with every event of the corpus, as a 4.x application registers them: the `@Type`-decorated event with
 * `ClassTransformerEventSerializer`, which is what 3.x's default serializer did, the others with the default
 * `JsonEventSerializer`. That the specs read every event as 3.0.2 did is the proof of ADR 0001 §6 on real 3.x data.
 */
export const createCrossVersionEventMap = (): EventMap => {
	const eventMap = new EventMap();
	const events: Type<object>[] = [
		AccountOpened,
		FundsWithdrawn,
		NoteAdded,
		DocumentAttached,
		AccountClosed,
		LedgerEntryRecorded,
	];
	for (const cls of events) {
		eventMap.register(cls, JsonEventSerializer.for(cls));
	}
	eventMap.register(FundsDeposited, ClassTransformerEventSerializer.for(FundsDeposited));
	return eventMap;
};

@Aggregate({ streamName: 'account' })
export class Account extends AggregateRoot {}

/** The longest stream name 3.x accepts; with its 69-character aggregate id the stream ids are 120 characters. */
export const LEDGER_STREAM_NAME = 'ledger-with-the-longest-stream-name-3x-allows-50ch';

@Aggregate({ streamName: LEDGER_STREAM_NAME })
export class Ledger extends AggregateRoot {}

const AGGREGATES: Record<string, Type<AggregateRoot>> = { account: Account, [LEDGER_STREAM_NAME]: Ledger };

const aggregateOf = (streamName: string): Type<AggregateRoot> => {
	const aggregate = AGGREGATES[streamName];
	if (!aggregate) {
		throw new Error(`The manifest names the aggregate '${streamName}', which packages/testing/cross-version lacks`);
	}
	return aggregate;
};

/** The event stream of a manifest stream. */
export const crossVersionEventStream = ({ aggregate, aggregateId }: { aggregate: string; aggregateId: string }) =>
	EventStream.for(aggregateOf(aggregate), Id.from(aggregateId));

/** The snapshot stream of a manifest stream. */
export const crossVersionSnapshotStream = ({ aggregate, aggregateId }: { aggregate: string; aggregateId: string }) =>
	SnapshotStream.for(aggregateOf(aggregate), Id.from(aggregateId));
