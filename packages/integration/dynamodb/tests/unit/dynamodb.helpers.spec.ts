import {
	BillingMode,
	CreateTableCommand,
	DescribeTableCommand,
	type DynamoDBClient,
	ResourceInUseException,
	ResourceNotFoundException,
	TableStatus,
	TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { NumberValueImpl as NumberValue, marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
	DEFAULT_PROVISIONED_THROUGHPUT,
	type DynamoDBTableDefinition,
	buildCreateTableInput,
	ensureTable,
	isConflictingTransaction,
	normalizePayload,
} from '@ocoda/event-sourcing-dynamodb/helpers';

const definition: DynamoDBTableDefinition = {
	TableName: 'dynamodb-helpers-events',
	KeySchema: [
		{ AttributeName: 'streamId', KeyType: 'HASH' },
		{ AttributeName: 'version', KeyType: 'RANGE' },
	],
	AttributeDefinitions: [
		{ AttributeName: 'streamId', AttributeType: 'S' },
		{ AttributeName: 'version', AttributeType: 'N' },
		{ AttributeName: 'eventDate', AttributeType: 'S' },
		{ AttributeName: 'eventId', AttributeType: 'S' },
	],
	GlobalSecondaryIndexes: [
		{
			IndexName: 'eventIdIndex',
			KeySchema: [
				{ AttributeName: 'eventDate', KeyType: 'HASH' },
				{ AttributeName: 'eventId', KeyType: 'RANGE' },
			],
			Projection: { ProjectionType: 'ALL' },
		},
	],
};

describe('DynamoDB helpers', () => {
	describe(normalizePayload, () => {
		it('should convert dates to ISO strings, like JSON.stringify does', () => {
			const date = new Date('2024-02-29T12:34:56.789Z');

			expect(normalizePayload(date)).toBe('2024-02-29T12:34:56.789Z');
			expect(normalizePayload(new Date('not a date'))).toBeNull();
			expect(normalizePayload({ at: date, nested: { list: [date, { at: date }] } })).toEqual({
				at: '2024-02-29T12:34:56.789Z',
				nested: { list: ['2024-02-29T12:34:56.789Z', { at: '2024-02-29T12:34:56.789Z' }] },
			});
		});

		it('should store the same payload as a JSON round-trip for JSON-compatible payloads', () => {
			const payload = {
				date: new Date('2021-01-01T00:00:00.000Z'),
				text: "It's a 'quoted' \"string\" with unicode: ÄÖÜ ß 你好 🚀",
				number: 42.5,
				negative: -1,
				flag: false,
				nothing: null,
				empty: '',
				list: [1, 'two', [3, [4]], { five: 5 }, new Date(0)],
				nested: { deeper: { deepest: { dates: [new Date(86_400_000)] } } },
			};

			expect(unmarshall(marshall({ payload: normalizePayload(payload) }, { convertClassInstanceToMap: true }))).toEqual(
				{
					payload: JSON.parse(JSON.stringify(payload)),
				},
			);
		});

		it('should keep values that marshall already stores natively', () => {
			const buffer = Buffer.from('buffer');
			const bytes = new Uint8Array([1, 2, 3]);
			const numberValue = NumberValue.from('12345678901234567890');
			const payload = normalizePayload({
				buffer,
				bytes,
				numberValue,
				bigint: BigInt(7),
				set: new Set(['a', 'b']),
				map: new Map([['at', new Date(0)]]),
				undefinedValue: undefined,
			}) as Record<string, unknown>;

			expect(payload.buffer).toBe(buffer);
			expect(payload.bytes).toBe(bytes);
			expect(payload.numberValue).toBe(numberValue);
			expect(payload.bigint).toBe(BigInt(7));
			expect(payload.set).toEqual(new Set(['a', 'b']));
			expect(payload.map).toEqual(new Map([['at', '1970-01-01T00:00:00.000Z']]));
			expect('undefinedValue' in payload).toBe(true);
			expect(
				marshall({ payload }, { removeUndefinedValues: true, convertClassInstanceToMap: true }).payload.M,
			).not.toHaveProperty('undefinedValue');
		});

		it('should map class instances like marshall does, without losing nested dates', () => {
			class Money {
				constructor(
					public readonly amount: number,
					public readonly currency: string,
					public readonly on: Date,
				) {}

				format() {
					return `${this.amount} ${this.currency}`;
				}
			}

			expect(normalizePayload({ price: new Money(10, 'EUR', new Date(0)) })).toEqual({
				price: { amount: 10, currency: 'EUR', on: '1970-01-01T00:00:00.000Z' },
			});
		});

		it('should not mutate the payload', () => {
			const date = new Date(0);
			const payload = { date, list: [date] };

			normalizePayload(payload);

			expect(payload.date).toBe(date);
			expect(payload.list[0]).toBe(date);
		});
	});

	describe(buildCreateTableInput, () => {
		it('should not send provisioned throughput for on-demand tables', () => {
			for (const config of [undefined, {}, { BillingMode: BillingMode.PAY_PER_REQUEST }]) {
				const input = buildCreateTableInput(definition, config);

				expect(input.BillingMode).toBe(BillingMode.PAY_PER_REQUEST);
				expect(input).not.toHaveProperty('ProvisionedThroughput');
				expect(input).not.toHaveProperty('OnDemandThroughput');
				for (const index of input.GlobalSecondaryIndexes || []) {
					expect(index).not.toHaveProperty('ProvisionedThroughput');
				}
			}
		});

		it('should ignore provisioned throughput for on-demand tables', () => {
			const input = buildCreateTableInput(definition, {
				ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
				OnDemandThroughput: { MaxReadRequestUnits: 10, MaxWriteRequestUnits: 10 },
			});

			expect(input.BillingMode).toBe(BillingMode.PAY_PER_REQUEST);
			expect(input).not.toHaveProperty('ProvisionedThroughput');
			expect(input.OnDemandThroughput).toEqual({ MaxReadRequestUnits: 10, MaxWriteRequestUnits: 10 });
			expect(input.GlobalSecondaryIndexes?.[0]).not.toHaveProperty('ProvisionedThroughput');
		});

		it('should provision the table and every index for provisioned tables', () => {
			const defaultInput = buildCreateTableInput(definition, { BillingMode: BillingMode.PROVISIONED });

			expect(defaultInput.BillingMode).toBe(BillingMode.PROVISIONED);
			expect(defaultInput.ProvisionedThroughput).toEqual(DEFAULT_PROVISIONED_THROUGHPUT);
			expect(defaultInput.GlobalSecondaryIndexes?.[0].ProvisionedThroughput).toEqual(DEFAULT_PROVISIONED_THROUGHPUT);

			const throughput = { ReadCapacityUnits: 5, WriteCapacityUnits: 3 };
			const input = buildCreateTableInput(definition, {
				BillingMode: BillingMode.PROVISIONED,
				ProvisionedThroughput: throughput,
			});

			expect(input.ProvisionedThroughput).toEqual(throughput);
			expect(input.GlobalSecondaryIndexes?.[0]).toEqual({
				...definition.GlobalSecondaryIndexes[0],
				ProvisionedThroughput: throughput,
			});
			expect(input.KeySchema).toEqual(definition.KeySchema);
			expect(input.AttributeDefinitions).toEqual(definition.AttributeDefinitions);
		});
	});

	describe(ensureTable, () => {
		const notFound = () => new ResourceNotFoundException({ message: 'Table not found', $metadata: {} });
		const describeResult = (status: TableStatus) => ({ Table: { TableStatus: status }, $metadata: {} });
		const fakeClient = (responses: ((command: unknown) => unknown)[]) => {
			const send = jest.fn(async (command: unknown) => {
				const respond = responses.shift();
				if (!respond) {
					throw new Error('Unexpected call');
				}
				return respond(command);
			});
			return { client: { send } as unknown as DynamoDBClient, send };
		};

		it('should create a missing table and wait until it is active', async () => {
			const { client, send } = fakeClient([
				() => Promise.reject(notFound()),
				() => ({ $metadata: {} }),
				() => describeResult(TableStatus.CREATING),
				() => describeResult(TableStatus.ACTIVE),
			]);

			await ensureTable(client, definition);

			const commands = send.mock.calls.map(([command]) => command);
			expect(commands[0]).toBeInstanceOf(DescribeTableCommand);
			expect(commands[1]).toBeInstanceOf(CreateTableCommand);
			expect(commands[2]).toBeInstanceOf(DescribeTableCommand);
			expect(commands[3]).toBeInstanceOf(DescribeTableCommand);
			expect(send).toHaveBeenCalledTimes(4);
		});

		it('should wait for a table that is still being created', async () => {
			const { client, send } = fakeClient([
				() => describeResult(TableStatus.CREATING),
				() => describeResult(TableStatus.ACTIVE),
			]);

			await ensureTable(client, definition);

			expect(send).toHaveBeenCalledTimes(2);
		});

		it('should wait for a table that is concurrently created elsewhere', async () => {
			const { client, send } = fakeClient([
				() => Promise.reject(notFound()),
				() => Promise.reject(new ResourceInUseException({ message: 'Table already exists', $metadata: {} })),
				() => describeResult(TableStatus.ACTIVE),
			]);

			await ensureTable(client, definition);

			expect(send).toHaveBeenCalledTimes(3);
		});

		it('should not wait for an existing table', async () => {
			const { client, send } = fakeClient([() => describeResult(TableStatus.ACTIVE)]);

			await ensureTable(client, definition);

			expect(send).toHaveBeenCalledTimes(1);
		});

		it('should rethrow unexpected errors', async () => {
			const error = new Error('Access denied');
			const { client } = fakeClient([() => Promise.reject(notFound()), () => Promise.reject(error)]);

			await expect(ensureTable(client, definition)).rejects.toBe(error);
		});
	});

	describe(isConflictingTransaction, () => {
		const cancelled = (...codes: string[]) =>
			new TransactionCanceledException({
				message: 'Transaction cancelled',
				$metadata: {},
				CancellationReasons: codes.map((Code) => ({ Code })),
			});

		it('should detect failed conditions and conflicting transactions', () => {
			expect(isConflictingTransaction(cancelled('None', 'ConditionalCheckFailed'))).toBe(true);
			expect(isConflictingTransaction(cancelled('TransactionConflict', 'None'))).toBe(true);
		});

		it('should not treat other failures as conflicts', () => {
			expect(isConflictingTransaction(cancelled('None', 'ThrottlingError'))).toBe(false);
			expect(isConflictingTransaction(cancelled('ValidationError'))).toBe(false);
			expect(isConflictingTransaction(cancelled())).toBe(false);
			expect(isConflictingTransaction(new Error('ConditionalCheckFailed'))).toBe(false);
			expect(isConflictingTransaction(undefined)).toBe(false);
		});
	});
});
