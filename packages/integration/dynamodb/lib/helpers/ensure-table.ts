import {
	BillingMode,
	CreateTableCommand,
	type CreateTableCommandInput,
	DescribeTableCommand,
	type DynamoDBClient,
	type ProvisionedThroughput,
	ResourceInUseException,
	ResourceNotFoundException,
	TableStatus,
	waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';

/**
 * The capacity settings that can be passed to `ensureCollection()`.
 */
export type DynamoDBTableConfig = Pick<
	CreateTableCommandInput,
	'BillingMode' | 'ProvisionedThroughput' | 'OnDemandThroughput'
>;

/**
 * The schema of a table managed by the stores.
 */
export type DynamoDBTableDefinition = Required<
	Pick<CreateTableCommandInput, 'TableName' | 'KeySchema' | 'AttributeDefinitions' | 'GlobalSecondaryIndexes'>
>;

/**
 * Throughput used for the table and its indexes when `BillingMode` is `PROVISIONED` and none is given.
 */
export const DEFAULT_PROVISIONED_THROUGHPUT: ProvisionedThroughput = { ReadCapacityUnits: 1, WriteCapacityUnits: 1 };

/**
 * How long (in seconds) `ensureTable()` waits at most for a table to become `ACTIVE`.
 */
export const TABLE_ACTIVE_MAX_WAIT_TIME = 300;

/**
 * Builds the CreateTable input for a table definition.
 *
 * `ProvisionedThroughput` may only be specified when `BillingMode` is `PROVISIONED` (the default is `PAY_PER_REQUEST`),
 * and is then required for the table as well as for every global secondary index.
 */
export function buildCreateTableInput(
	definition: DynamoDBTableDefinition,
	config?: DynamoDBTableConfig,
): CreateTableCommandInput {
	const billingMode = config?.BillingMode || BillingMode.PAY_PER_REQUEST;
	const throughput =
		billingMode === BillingMode.PROVISIONED
			? { ProvisionedThroughput: config?.ProvisionedThroughput || DEFAULT_PROVISIONED_THROUGHPUT }
			: {};

	return {
		...definition,
		GlobalSecondaryIndexes: definition.GlobalSecondaryIndexes.map((index) => ({ ...index, ...throughput })),
		BillingMode: billingMode,
		...throughput,
		...(config?.OnDemandThroughput && { OnDemandThroughput: config.OnDemandThroughput }),
	};
}

/**
 * Creates a table if it doesn't exist yet and waits until it is `ACTIVE`, since CreateTable returns while the
 * table is still being created. A table that is concurrently created elsewhere is waited for as well.
 */
export async function ensureTable(
	client: DynamoDBClient,
	definition: DynamoDBTableDefinition,
	config?: DynamoDBTableConfig,
): Promise<void> {
	const { TableName } = definition;

	let status: string | undefined;
	try {
		const { Table } = await client.send(new DescribeTableCommand({ TableName }));
		status = Table?.TableStatus;
	} catch (error) {
		if (!(error instanceof ResourceNotFoundException)) {
			throw error;
		}

		try {
			await client.send(new CreateTableCommand(buildCreateTableInput(definition, config)));
		} catch (error) {
			// The table is already being created, e.g. by another instance of the application
			if (!(error instanceof ResourceInUseException)) {
				throw error;
			}
		}

		status = TableStatus.CREATING;
	}

	if (status === TableStatus.CREATING) {
		await waitUntilTableExists(
			{ client, maxWaitTime: TABLE_ACTIVE_MAX_WAIT_TIME, minDelay: 1, maxDelay: 5 },
			{ TableName },
		);
	}
}
