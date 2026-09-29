import type { Type } from '@nestjs/common';
import {
	Aggregate,
	AggregateRoot,
	DefaultEventSerializer,
	Event,
	EventMap,
	EventStream,
	Id,
	type IEventPayload,
	type IEventSerializer,
	SnapshotStream,
} from '@ocoda/event-sourcing';

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

@Event('funds-deposited')
export class FundsDeposited {
	constructor(
		public readonly amount: Money,
		public readonly reference: string,
	) {}
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
 * The 3.x writer decorates `FundsDeposited.amount` with class-transformer's `@Type(() => Money)`, so 3.x reads it back
 * as a `Money`. The testing package can't import class-transformer (it isn't a dependency), so this serializer does
 * what the decorator does: the default deserialization, then a `Money` built without arguments with the stored keys
 * assigned. Swap it for `ClassTransformerEventSerializer` and a real `@Type` when the serializer change lands.
 */
export class FundsDepositedSerializer implements IEventSerializer<FundsDeposited> {
	private readonly serializer = DefaultEventSerializer.for(FundsDeposited);

	serialize(event: FundsDeposited): IEventPayload<FundsDeposited> {
		return this.serializer.serialize(event);
	}

	deserialize(payload: IEventPayload<FundsDeposited>): FundsDeposited {
		const event = this.serializer.deserialize(payload);
		if (event.amount !== null && typeof event.amount === 'object') {
			const money = new Money(undefined as never, undefined as never);
			Object.assign(event, { amount: Object.assign(money, event.amount) });
		}
		return event;
	}
}

/** An event map with every event of the corpus, serialized the way the 3.x writer registered them. */
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
		eventMap.register(cls, DefaultEventSerializer.for(cls));
	}
	eventMap.register(FundsDeposited, new FundsDepositedSerializer());
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
