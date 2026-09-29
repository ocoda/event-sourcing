import 'reflect-metadata';
import { Inject, Injectable, Optional, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import {
	CommandHandlerNotFoundException,
	InvalidCommandHandlerException,
	MissingCommandHandlerMetadataException,
} from './exceptions/index.js';
import { DefaultCommandPubSub, ObservableBus, getCommandHandlerMetadata } from './helpers/index.js';
import { classOf, handlerFor } from './helpers/message-handlers.js';
import type { ICommand, ICommandBus, ICommandHandler, ICommandPublisher, ProviderWrapper } from './interfaces/index.js';
import type { ResultOf } from './models/index.js';
import { isStaticProvider, providerClassOf } from './registration/providers.js';
import { EVENT_SOURCING_REGISTRATION, type Registration } from './registration/registration.js';
import { ScopedHandler } from './registration/scoped-handler.js';

@Injectable()
export class CommandBus<CommandBase extends ICommand = ICommand>
	extends ObservableBus<CommandBase>
	implements ICommandBus<CommandBase>
{
	// Keyed by the command class itself, not by an id stored on it, which a subclass would inherit.
	private readonly handlers = new Map<Function, ICommandHandler<any, unknown> | ScopedHandler<ICommandHandler>>();
	private _publisher: ICommandPublisher<CommandBase> = new DefaultCommandPubSub<CommandBase>(this.subject$);

	/**
	 * @param moduleRef In the `EventSourcingModule`: resolves the handlers that are not singletons, per call.
	 * @param registration In the `EventSourcingModule`: registers the handlers on the first `execute`, if the module
	 * hasn't yet.
	 */
	constructor(
		@Optional() private readonly moduleRef?: ModuleRef,
		@Optional() @Inject(EVENT_SOURCING_REGISTRATION) private readonly registration?: Registration,
	) {
		super();
	}

	get publisher(): ICommandPublisher<CommandBase> {
		return this._publisher;
	}
	set publisher(_publisher: ICommandPublisher<CommandBase>) {
		this._publisher = _publisher;
	}

	/**
	 * Executes a command with the handler registered for its class, or for its nearest parent class that has one, and
	 * resolves to what the handler resolves to.
	 *
	 * The result type is inferred from a `Command<TResult>`; for a plain command class it is `any`, or the second
	 * type argument: `execute<OpenAccountCommand, AccountId>(command)`.
	 *
	 * A handler that is not a singleton (request-scoped, transient, or depending on a request-scoped provider) is
	 * resolved for every call: in the DI context of `options.request`, which it can inject with `@Inject(REQUEST)`, or,
	 * without a request, in a new context, so every call gets a new instance.
	 *
	 * @param options.request The request the command is executed for, such as the request object of a controller.
	 * @throws {CommandHandlerNotFoundException} (as a rejection) when no handler is registered for the command's class
	 * or any of its parent classes. Nothing is published then.
	 * @throws {EventSourcingNotReadyException} (as a rejection) when called while Nest is still instantiating the
	 * providers, from a provider factory or constructor.
	 */
	async execute<TCommand extends CommandBase, TResult = ResultOf<TCommand>>(
		command: TCommand,
		options?: { request?: unknown },
	): Promise<NoInfer<TResult>> {
		this.registration?.ensureRegistered('CommandBus.execute');
		const commandType = classOf(command);
		const binding = handlerFor(this.handlers, commandType);
		if (!binding) {
			throw new CommandHandlerNotFoundException({ command: commandType ?? command });
		}
		const handler = binding instanceof ScopedHandler ? await binding.resolve(options?.request) : binding;
		this._publisher.publish(command);
		return (await handler.execute(command)) as NoInfer<TResult>;
	}

	/**
	 * Routes the instances of `command`, and of its subclasses without a handler of their own, to `handler`, replacing a
	 * handler registered for it before.
	 */
	bind<TCommand extends CommandBase>(handler: ICommandHandler<TCommand>, command: Type<TCommand>) {
		this.handlers.set(command, handler);
	}

	register(handlers: ProviderWrapper<ICommandHandler>[] = []) {
		for (const handler of handlers) {
			this.registerHandler(handler);
		}
	}
	/**
	 * Registers a handler as Nest's discovery lists it. The metadata is read from the class of its instance, so that
	 * factory and value providers work. A singleton is bound as it is; any other handler is resolved per call.
	 */
	protected registerHandler(handler: ProviderWrapper<ICommandHandler>) {
		const type = providerClassOf(handler);
		const isStatic = isStaticProvider(handler);
		if (!type || (isStatic && !handler.instance) || (!isStatic && !this.moduleRef)) {
			throw new InvalidCommandHandlerException({ handler: handler?.instance ?? type });
		}

		// get the command the handler handles
		const { command } = getCommandHandlerMetadata(type as Type<ICommandHandler>);
		if (typeof command !== 'function') {
			throw new MissingCommandHandlerMetadataException({ handler: type });
		}

		if (isStatic) {
			this.bind(handler.instance as ICommandHandler<CommandBase>, command as Type<CommandBase>);
		} else {
			this.handlers.set(command, new ScopedHandler<ICommandHandler>(handler.token, this.moduleRef as ModuleRef));
		}
	}
}
