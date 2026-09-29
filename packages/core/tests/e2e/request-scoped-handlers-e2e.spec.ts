import { Controller, Get, Inject, type INestApplication, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Command, CommandBus, CommandHandler, EventSourcingModule, type ICommandHandler } from '@ocoda/event-sourcing';

// ADR 0001 §3: `execute(message, { request })` resolves a request-scoped handler in the DI context that Nest created
// for the request-scoped controller handling that request, so both share the request's instances.

let contexts = 0;

@Injectable({ scope: Scope.REQUEST })
class RequestContext {
	readonly id = ++contexts;
}

class WhichContextCommand extends Command<number> {}

// A singleton by declaration, request-scoped through its dependency
@CommandHandler(WhichContextCommand)
class WhichContextHandler implements ICommandHandler<WhichContextCommand> {
	constructor(private readonly context: RequestContext) {}
	async execute() {
		return this.context.id;
	}
}

@Controller('context')
class ContextController {
	constructor(
		private readonly commandBus: CommandBus,
		private readonly context: RequestContext,
		@Inject(REQUEST) private readonly request: unknown,
	) {}

	@Get()
	async get() {
		const first = await this.commandBus.execute(new WhichContextCommand(), { request: this.request });
		const second = await this.commandBus.execute(new WhichContextCommand(), { request: this.request });
		return { controller: this.context.id, first, second };
	}
}

describe('request-scoped handlers over HTTP - e2e', () => {
	let app: INestApplication | undefined;
	let url: string;

	beforeAll(async () => {
		const moduleRef = await Test.createTestingModule({
			imports: [EventSourcingModule.forRoot({})],
			controllers: [ContextController],
			providers: [RequestContext, WhichContextHandler],
		}).compile();

		app = moduleRef.createNestApplication();
		await app.listen(0, '127.0.0.1');
		url = `${await app.getUrl()}/context`;
	});

	afterAll(async () => {
		await app?.close();
	});

	type Seen = { controller: number; first: number; second: number };
	const get = async (): Promise<Seen> => (await (await fetch(url)).json()) as Seen;

	it('resolves the handlers in the DI context of the request-scoped controller, one per request', async () => {
		const first = await get();
		const second = await get();

		expect(first).toEqual({ controller: first.controller, first: first.controller, second: first.controller });
		expect(second).toEqual({ controller: second.controller, first: second.controller, second: second.controller });
		expect(second.controller).not.toBe(first.controller);
	});
});
