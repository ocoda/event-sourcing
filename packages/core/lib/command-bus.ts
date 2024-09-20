import { Injectable } from '@nestjs/common';
import 'reflect-metadata';
import { CommandHandlerNotFoundException, MissingCommandMetadataException } from './exceptions';
import { DefaultCommandPubSub, ObservableBus, getCommandMetadata } from './helpers';
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
}
