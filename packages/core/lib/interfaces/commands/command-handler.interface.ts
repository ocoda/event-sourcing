import type { ICommand } from './command.interface.js';

export interface ICommandHandler<TCommand extends ICommand = any, TResult = any> {
	execute(command: TCommand): Promise<TResult>;
}
