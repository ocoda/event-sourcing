import 'reflect-metadata';
import { Injectable, type Type } from '@nestjs/common';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';

import {
	CommandHandlerNotFoundException,
	MissingCommandHandlerMetadataException,
	MissingCommandMetadataException,
} from './exceptions';
import { DefaultCommandPubSub, ObservableBus, getCommandHandlerMetadata, getCommandMetadata } from './helpers';
import type { ICommand, ICommandBus, ICommandHandler, ICommandPublisher } from './interfaces';

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
			throw new CommandHandlerNotFoundException(commandId);
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
			throw new MissingCommandMetadataException(commandType);
		}

		return id;
	}

	// region registration
	register(handlers: InstanceWrapper<ICommandHandler>[] = []) {
		for (const handler of handlers) {
			this.registerHandler(handler);
		}
	}
	protected registerHandler(handler: InstanceWrapper<ICommandHandler>) {
		// get the metadata from the handler
		const { metatype, instance } = handler;

		// if the handler is not a command handler, return
		if (!metatype || !instance) {
			throw new Error('Invalid command handler instance provided.');
		}

		// get the command metadata
		const { command } = getCommandHandlerMetadata(metatype as Type<ICommandHandler>);

		// check the command metadata
		if (!command) {
			throw new MissingCommandHandlerMetadataException(metatype);
		}

		// get the command id
		const { id } = getCommandMetadata(command);

		// check the command id
		if (!id) {
			throw new MissingCommandMetadataException(command);
		}

		// bind the handler to the command id
		this.bind(instance as ICommandHandler, id);
	}
	// endregion
}
