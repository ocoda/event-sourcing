import type { ICommand } from './command.interface.js';

export interface ICommandPublisher<CommandBase extends ICommand = ICommand> {
	publish<T extends CommandBase = CommandBase>(command: T): any;
}
