import type { ProviderWrapper } from '@ocoda/event-sourcing';
import {
	EventSourcingErrorCode,
	InvalidQueryHandlerException,
	type IQuery,
	type IQueryBus,
	type IQueryHandler,
	MissingQueryHandlerMetadataException,
	Query,
	QueryBus,
	QueryHandler,
	QueryHandlerNotFoundException,
	type ResultOf,
} from '@ocoda/event-sourcing';
import { QUERY_HANDLER_METADATA, QUERY_METADATA } from '@ocoda/event-sourcing/decorators';

// ADR 0001 §7: typed buses. The type assertions are checked by `pnpm typecheck`, the rest at runtime.
describe(QueryBus, () => {
	interface AccountDto {
		id: string;
		balance: number;
	}

	class GetAccountQuery extends Query<AccountDto | undefined> {
		constructor(readonly accountId: string) {
			super();
		}
	}

	// A 3.x query: a plain class
	class GetAccountsQuery implements IQuery {}

	const account: AccountDto = { id: 'account-1', balance: 10 };

	const busWithHandlers = () => {
		const bus = new QueryBus();
		bus.bind({ execute: async ({ accountId }: GetAccountQuery) => ({ ...account, id: accountId }) }, GetAccountQuery);
		bus.bind({ execute: async () => [account] }, GetAccountsQuery);
		return bus;
	};

	describe('result types', () => {
		it('infers the result of a Query<TResult> without a type argument', async () => {
			const result = busWithHandlers().execute(new GetAccountQuery('account-2'));

			expectTypeOf(result).toEqualTypeOf<Promise<AccountDto | undefined>>();
			await expect(result).resolves.toEqual({ id: 'account-2', balance: 10 });
		});

		it('keeps both 3.x generic forms compiling', async () => {
			const bus = busWithHandlers();

			const accounts = bus.execute<GetAccountsQuery>(new GetAccountsQuery());
			const typedAccounts = bus.execute<GetAccountsQuery, AccountDto[]>(new GetAccountsQuery());
			const inferredAccounts = bus.execute(new GetAccountsQuery());

			expectTypeOf(accounts).resolves.toBeAny();
			expectTypeOf(typedAccounts).toEqualTypeOf<Promise<AccountDto[]>>();
			expectTypeOf(inferredAccounts).resolves.toBeAny();
			await expect(accounts).resolves.toEqual([account]);
			await expect(typedAccounts).resolves.toEqual([account]);
			await expect(inferredAccounts).resolves.toEqual([account]);
		});

		it('resolves ResultOf and the handler interface to the result of the query', () => {
			expectTypeOf<ResultOf<GetAccountQuery>>().toEqualTypeOf<AccountDto | undefined>();
			expectTypeOf<ResultOf<GetAccountsQuery>>().toBeAny();
			expectTypeOf<IQuery>().toEqualTypeOf<object>();
			expectTypeOf<IQueryHandler<GetAccountQuery>['execute']>().returns.toEqualTypeOf<
				Promise<AccountDto | undefined>
			>();
			expectTypeOf<IQueryHandler<GetAccountsQuery, AccountDto[]>['execute']>().returns.toEqualTypeOf<
				Promise<AccountDto[]>
			>();
			expectTypeOf<IQueryHandler['execute']>().returns.toEqualTypeOf<Promise<any>>();
			expectTypeOf<QueryBus>().toExtend<IQueryBus>();
		});

		it('rejects what is not a query, and handlers with the wrong result, at compile time', () => {
			// Never called: the calls below would fail at runtime too.
			const compileTimeOnly = (bus: QueryBus) => {
				// @ts-expect-error a number is not a query
				void bus.execute(42);
				// @ts-expect-error the result of a typed query can't be retyped
				const _wrongResult: Promise<string> = bus.execute(new GetAccountQuery('account-1'));
				// @ts-expect-error Query has no default result type
				class _UntypedQuery extends Query {}

				// @ts-expect-error the decorator takes a class
				@QueryHandler('GetAccountQuery')
				class _StringHandler {
					async execute() {}
				}

				// @ts-expect-error the handler resolves to a string, the query to an AccountDto
				@QueryHandler(GetAccountQuery)
				class _WrongResultHandler {
					async execute(_query: GetAccountQuery): Promise<string> {
						return 'account-1';
					}
				}
			};

			expectTypeOf(compileTimeOnly).toBeFunction();
		});

		it('emits nothing for the result brand, so query payloads are unchanged', () => {
			const query = new GetAccountQuery('account-1');

			expect(Object.getOwnPropertySymbols(query)).toEqual([]);
			expect(JSON.stringify(query)).toBe('{"accountId":"account-1"}');
			expect(Reflect.ownKeys(Query.prototype)).toEqual(['constructor']);
		});
	});

	describe('execute', () => {
		it('rejects, without throwing, when no handler is registered for the query', async () => {
			const bus = new QueryBus();
			const received: IQuery[] = [];
			const subscription = bus.subscribe((query) => received.push(query));

			let execution: Promise<unknown> | undefined;
			expect(() => {
				execution = bus.execute(new GetAccountQuery('account-1'));
			}).not.toThrow();

			await expect(execution).rejects.toBeInstanceOf(QueryHandlerNotFoundException);
			await expect(execution).rejects.toMatchObject({
				code: EventSourcingErrorCode.QueryHandlerNotFound,
				queryName: 'GetAccountQuery',
			});
			subscription.unsubscribe();
			expect(received).toEqual([]);
		});

		it('rejects for a query class that no handler was ever declared for', async () => {
			// 3.x threw a MissingQueryMetadataException synchronously
			class UndeclaredQuery {}

			await expect(new QueryBus().execute(new UndeclaredQuery())).rejects.toMatchObject({
				code: EventSourcingErrorCode.QueryHandlerNotFound,
				queryName: 'UndeclaredQuery',
			});
		});

		it('rejects for a value without a class', async () => {
			const bus = new QueryBus();

			await expect(bus.execute(Object.create(null))).rejects.toBeInstanceOf(QueryHandlerNotFoundException);
			await expect(bus.execute(undefined as unknown as IQuery)).rejects.toBeInstanceOf(QueryHandlerNotFoundException);
			await expect(bus.execute(42 as unknown as IQuery)).rejects.toMatchObject({ queryName: 'Number' });
		});

		it('rejects with the error of a handler that throws synchronously', async () => {
			const bus = new QueryBus();
			const failure = new Error('handler failed');
			bus.bind(
				{
					execute: () => {
						throw failure;
					},
				},
				GetAccountsQuery,
			);

			let execution: Promise<unknown> | undefined;
			expect(() => {
				execution = bus.execute(new GetAccountsQuery());
			}).not.toThrow();
			await expect(execution).rejects.toBe(failure);
		});

		it('publishes the query before its handler runs', async () => {
			const bus = new QueryBus();
			const order: string[] = [];
			bus.bind(
				{
					execute: async () => {
						order.push('handled');
						return [];
					},
				},
				GetAccountsQuery,
			);
			const subscription = bus.subscribe(() => order.push('published'));

			await bus.execute(new GetAccountsQuery());
			subscription.unsubscribe();

			expect(order).toEqual(['published', 'handled']);
		});

		it('publishes through a replaced publisher', async () => {
			const bus = busWithHandlers();
			const published: IQuery[] = [];
			const publisher = { publish: (query: IQuery) => published.push(query) };
			bus.publisher = publisher;

			const query = new GetAccountsQuery();
			await bus.execute(query);

			expect(bus.publisher).toBe(publisher);
			expect(published).toEqual([query]);
		});
	});

	describe('handlers are keyed by class', () => {
		it('does not route a subclass to the handler of its parent', async () => {
			class GetClosedAccountQuery extends GetAccountQuery {}

			await expect(busWithHandlers().execute(new GetClosedAccountQuery('account-1'))).rejects.toMatchObject({
				code: EventSourcingErrorCode.QueryHandlerNotFound,
				queryName: 'GetClosedAccountQuery',
			});
		});

		it('ignores the id metadata on the query class', async () => {
			class FirstQuery {}
			class SecondQuery {}
			Reflect.defineMetadata(QUERY_METADATA, { id: 'shared-id' }, FirstQuery);
			Reflect.defineMetadata(QUERY_METADATA, { id: 'shared-id' }, SecondQuery);
			const bus = new QueryBus();
			bus.bind({ execute: async () => 'first' }, FirstQuery);

			await expect(bus.execute(new FirstQuery())).resolves.toBe('first');
			await expect(bus.execute(new SecondQuery())).rejects.toBeInstanceOf(QueryHandlerNotFoundException);
		});

		it('keeps the handlers of two buses apart', async () => {
			const first = new QueryBus();
			const second = new QueryBus();
			first.bind({ execute: async () => 'first' }, GetAccountsQuery);
			second.bind({ execute: async () => 'second' }, GetAccountsQuery);

			await expect(first.execute(new GetAccountsQuery())).resolves.toBe('first');
			await expect(second.execute(new GetAccountsQuery())).resolves.toBe('second');
		});
	});

	describe('register', () => {
		class HandlerWithoutMetadata {
			async execute() {
				return 'ok';
			}
		}

		it('throws when registering a handler without instance', () => {
			const bus = new QueryBus();
			const wrapper = { metatype: HandlerWithoutMetadata, instance: undefined } as unknown as ProviderWrapper;

			expect(() => bus.register([wrapper])).toThrow(InvalidQueryHandlerException);
		});

		it('throws when registering a handler without handler metadata', () => {
			const bus = new QueryBus();
			const wrapper = {
				metatype: HandlerWithoutMetadata,
				instance: new HandlerWithoutMetadata(),
			} as unknown as ProviderWrapper;

			expect(() => bus.register([wrapper])).toThrow(MissingQueryHandlerMetadataException);
		});

		it('registers a decorated handler for its query class', async () => {
			@QueryHandler(GetAccountQuery)
			class GetAccountQueryHandler implements IQueryHandler<GetAccountQuery> {
				async execute({ accountId }: GetAccountQuery): Promise<AccountDto | undefined> {
					return accountId === 'missing' ? undefined : { id: accountId, balance: 0 };
				}
			}
			const bus = new QueryBus();
			bus.register([{ metatype: GetAccountQueryHandler, instance: new GetAccountQueryHandler() } as ProviderWrapper]);

			await expect(bus.execute(new GetAccountQuery('account-1'))).resolves.toEqual({ id: 'account-1', balance: 0 });
			await expect(bus.execute(new GetAccountQuery('missing'))).resolves.toBeUndefined();
		});

		it('registers a handler for a query class without id metadata', async () => {
			// 3.x threw a MissingQueryMetadataException: it routed by an id that @QueryHandler() stores on the class
			class QueryWithoutMetadata {}
			class HandlerForQueryWithoutMetadata {
				async execute() {
					return 'ok';
				}
			}
			Reflect.defineMetadata(QUERY_HANDLER_METADATA, { query: QueryWithoutMetadata }, HandlerForQueryWithoutMetadata);
			const bus = new QueryBus();
			bus.register([
				{
					metatype: HandlerForQueryWithoutMetadata,
					instance: new HandlerForQueryWithoutMetadata(),
				} as unknown as ProviderWrapper,
			]);

			await expect(bus.execute(new QueryWithoutMetadata())).resolves.toBe('ok');
		});
	});
});
