import 'reflect-metadata';
import { Injectable, type Type } from '@nestjs/common';

import {
	CommandHandlerNotFoundException,
	InvalidCommandHandlerException,
	MissingCommandHandlerMetadataException,
} from './exceptions/index.js';
import { DefaultCommandPubSub, ObservableBus, getCommandHandlerMetadata } from './helpers/index.js';
import { classOf, handlerFor } from './helpers/message-handlers.js';
import type { ICommand, ICommandBus, ICommandHandler, ICommandPublisher, ProviderWrapper } from './interfaces/index.js';
import type { ResultOf } from './models/index.js';

@Injectable()
export class CommandBus<CommandBase extends ICommand = ICommand>
	extends ObservableBus<CommandBase>
	implements ICommandBus<CommandBase>
{
	// Keyed by the command class itself, not by an id stored on it, which a subclass would inherit.
	private readonly handlers = new Map<Function, ICommandHandler<any, unknown>>();
	private _publisher: ICommandPublisher<CommandBase> = new DefaultCommandPubSub<CommandBase>(this.subject$);

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
	 * @param options Reserved for request-scoped handlers, which a later 4.0 prerelease resolves per request. Until
	 * then it is ignored.
	 * @throws {CommandHandlerNotFoundException} (as a rejection) when no handler is registered for the command's class
	 * or any of its parent classes. Nothing is published then.
	 */
	async execute<TCommand extends CommandBase, TResult = ResultOf<TCommand>>(
		command: TCommand,
		options?: { request?: unknown },
	): Promise<NoInfer<TResult>> {
		const commandType = classOf(command);
		const handler = handlerFor(this.handlers, commandType);
		if (!handler) {
			throw new CommandHandlerNotFoundException({ command: commandType ?? command });
		}
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
	protected registerHandler(handler: ProviderWrapper<ICommandHandler>) {
		// get the metadata from the handler
		const { metatype, instance } = handler;

		// if the handler is not a command handler, return
		if (!metatype || !instance) {
			throw new InvalidCommandHandlerException({ handler: instance });
		}

		// get the command the handler handles
		const { command } = getCommandHandlerMetadata(metatype as Type<ICommandHandler>);

		// check the command metadata
		if (typeof command !== 'function') {
			throw new MissingCommandHandlerMetadataException({ handler: metatype });
		}

		// bind the handler to the command class
		this.bind(instance, command as Type<CommandBase>);
	}
}
