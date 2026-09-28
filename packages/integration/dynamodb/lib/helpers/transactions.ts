import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';

/**
 * The maximum number of items in a single TransactWriteItems call.
 * A transaction is also limited to 4 MB in total, and every item to 400 KB.
 * @see https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html
 */
export const MAX_TRANSACTION_ITEMS = 100;

const CONFLICT_CANCELLATION_CODES = new Set(['ConditionalCheckFailed', 'TransactionConflict']);

/**
 * Whether a TransactWriteItems call was cancelled because one of its conditions failed (e.g. the item already
 * exists), or because a concurrent transaction was writing the same item.
 */
export function isConflictingTransaction(error: unknown): error is TransactionCanceledException {
	return (
		error instanceof TransactionCanceledException &&
		(error.CancellationReasons || []).some(({ Code }) => CONFLICT_CANCELLATION_CODES.has(Code as string))
	);
}
