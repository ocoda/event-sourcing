import { Injectable, Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import 'reflect-metadata';
import { COMMAND_METADATA } from './decorators';
import { CommandHandlerNotFoundException } from './exceptions';
import { DefaultCommandPubSub, ObservableBus } from './helpers';
import { CommandMetadata, ICommand, ICommandBus, ICommandHandler, ICommandPublisher } from './interfaces';

export type CommandHandlerType = Type<ICommandHandler<ICommand>>;

@Injectable()
export class CommandBus<CommandBase extends ICommand = ICommand>
	extends ObservableBus<CommandBase>
	implements ICommandBus<CommandBase>
{
	private handlers = new Map<string, ICommandHandler<CommandBase>>();
	private _publisher: ICommandPublisher<CommandBase>;

	constructor(private readonly moduleRef: ModuleRef) {
		super();
		this.useDefaultPublisher();
	}

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
		const commandMetadata: CommandMetadata = Reflect.getMetadata(COMMAND_METADATA, commandType);
		if (!commandMetadata) {
			throw new CommandHandlerNotFoundException(commandType.name);
		}

		return commandMetadata.id;
	}

	private useDefaultPublisher() {
		this._publisher = new DefaultCommandPubSub<CommandBase>(this.subject$);
	}
}
