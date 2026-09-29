import 'reflect-metadata';
import { Injectable, type Type } from '@nestjs/common';

import {
	CommandHandlerNotFoundException,
	InvalidCommandHandlerException,
	MissingCommandHandlerMetadataException,
	MissingCommandMetadataException,
} from './exceptions/index.js';
import { DefaultCommandPubSub, ObservableBus, getCommandHandlerMetadata, getCommandMetadata } from './helpers/index.js';
import type { ICommand, ICommandBus, ICommandHandler, ICommandPublisher, ProviderWrapper } from './interfaces/index.js';

@Injectable()
export class CommandBus<CommandBase extends ICommand = ICommand>
	extends ObservableBus<CommandBase>
	implements ICommandBus<CommandBase>
{
	private handlers = new Map<string, ICommandHandler<CommandBase>>();
	private _publisher: ICommandPublisher<CommandBase> = new DefaultCommandPubSub<CommandBase>(this.subject$);

	get publisher(): ICommandPublisher<CommandBase> {
		return this._publisher;
	}
	set publisher(_publisher: ICommandPublisher<CommandBase>) {
		this._publisher = _publisher;
	}

	execute<T extends CommandBase, R = any>(command: T): Promise<R> {
		const commandId = this.getCommandId(command);
		const handler = this.handlers.get(commandId);
		if (!handler) {
			throw new CommandHandlerNotFoundException({ command });
		}
		this._publisher.publish(command);
		return handler.execute(command);
	}
	bind<T extends CommandBase>(handler: ICommandHandler<T>, id: string) {
		this.handlers.set(id, handler);
	}

	private getCommandId(command: CommandBase): string {
		const { constructor: commandType } = Object.getPrototypeOf(command);
		const { id } = getCommandMetadata(commandType);

		if (!id) {
			throw new MissingCommandMetadataException({ command: commandType });
		}

		return id;
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

		// get the command metadata
		const { command } = getCommandHandlerMetadata(metatype as Type<ICommandHandler>);

		// check the command metadata
		if (!command) {
			throw new MissingCommandHandlerMetadataException({ handler: metatype });
		}

		// get the command id
		const { id } = getCommandMetadata(command);

		// check the command id
		if (!id) {
			throw new MissingCommandMetadataException({ command });
		}

		// bind the handler to the command id
		this.bind(instance as ICommandHandler, id);
	}
}
