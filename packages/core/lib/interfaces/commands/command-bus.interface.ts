import type { ResultOf } from '../../models/message.js';
import type { ICommand } from './command.interface.js';

export interface ICommandBus<CommandBase extends ICommand = ICommand> {
	execute<TCommand extends CommandBase, TResult = ResultOf<TCommand>>(
		command: TCommand,
		options?: { request?: unknown },
	): Promise<NoInfer<TResult>>;
}
