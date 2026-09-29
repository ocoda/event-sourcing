// The 3.x domain of the cross-version corpus: events, aggregates and the nested classes of their payloads.
//
// Plain ESM without a TypeScript toolchain, so the decorators are applied as functions. The event classes assign
// every constructor parameter, like TypeScript parameter properties do: class-transformer calls the constructor
// without arguments when it deserializes, so the own keys of a read-back event are the constructor parameters plus
// the keys of the stored payload.
//
// packages/testing/cross-version/domain.ts mirrors these classes (same event names, class names, stream names and
// fields) for the master reader. Change both together.
//
// The event classes only hold data. The lint rule accepts that for decorated classes, but can't see decorators that
// are applied as functions:
// oxlint-disable typescript/no-extraneous-class
import 'reflect-metadata';
import { Aggregate, AggregateRoot, Event, EventHandler } from '@ocoda/event-sourcing';
import { Type } from 'class-transformer';

/** Nested in `FundsDeposited` and turned back into an instance by `@Type(() => Money)` only. */
export class Money {
	constructor(amount, currency) {
		this.amount = amount;
		this.currency = currency;
	}
}

/** Carries a nested `ValueObject` (an `Id`, stored as `{ props: { value } }`) and a `Date`. */
export class AccountOpened {
	constructor(accountId, owner, openedOn, tags) {
		this.accountId = accountId;
		this.owner = owner;
		this.openedOn = openedOn;
		this.tags = tags;
	}
}
Event('account-opened')(AccountOpened);

/** The `@Type`-decorated event: its `amount` is read back as a `Money` instance. */
export class FundsDeposited {
	constructor(amount, reference) {
		this.amount = amount;
		this.reference = reference;
	}
}
Event('funds-deposited')(FundsDeposited);
Type(() => Money)(FundsDeposited.prototype, 'amount');

export class FundsWithdrawn {
	constructor(amount, memo) {
		this.amount = amount;
		this.memo = memo;
	}
}
Event('funds-withdrawn')(FundsWithdrawn);

/** Unicode text. */
export class NoteAdded {
	constructor(text) {
		this.text = text;
	}
}
Event('note-added')(NoteAdded);

/** A large payload (about 100 KB). */
export class DocumentAttached {
	constructor(name, content) {
		this.name = name;
		this.content = content;
	}
}
Event('document-attached')(DocumentAttached);

export class AccountClosed {
	constructor(reason) {
		this.reason = reason;
	}
}
Event('account-closed')(AccountClosed);

export class LedgerEntryRecorded {
	constructor(sequence, value) {
		this.sequence = sequence;
		this.value = value;
	}
}
Event('ledger-entry-recorded')(LedgerEntryRecorded);

export const EVENTS = [
	AccountOpened,
	FundsDeposited,
	FundsWithdrawn,
	NoteAdded,
	DocumentAttached,
	AccountClosed,
	LedgerEntryRecorded,
];

export class Account extends AggregateRoot {
	static open(accountId, owner, openedOn) {
		const account = new Account();
		account.applyEvent(new AccountOpened(accountId, owner, openedOn, ['commit-path']));
		return account;
	}

	deposit(amount, currency, reference) {
		this.applyEvent(new FundsDeposited(new Money(amount, currency), reference));
	}

	withdraw(amount, memo) {
		this.applyEvent(new FundsWithdrawn(amount, memo));
	}

	onAccountOpened(event) {
		this.accountId = event.accountId;
		this.balance = 0;
	}

	onFundsDeposited(event) {
		this.balance += event.amount.amount;
	}

	onFundsWithdrawn(event) {
		this.balance -= event.amount;
	}
}
Aggregate({ streamName: 'account' })(Account);
EventHandler(AccountOpened)(Account.prototype, 'onAccountOpened');
EventHandler(FundsDeposited)(Account.prototype, 'onFundsDeposited');
EventHandler(FundsWithdrawn)(Account.prototype, 'onFundsWithdrawn');

/**
 * The longest stream name 3.x accepts (50 characters). With a 69-character aggregate id its stream ids are 120
 * characters long, the width of the 3.x `stream_id` columns.
 */
export const LEDGER_STREAM_NAME = 'ledger-with-the-longest-stream-name-3x-allows-50ch';

export class Ledger extends AggregateRoot {}
Aggregate({ streamName: LEDGER_STREAM_NAME })(Ledger);

/** The aggregates by stream name, as the manifest names them. */
export const AGGREGATES = { account: Account, [LEDGER_STREAM_NAME]: Ledger };
