import type { ResultOf } from '../../models/message.js';
import type { ICommand } from './command.interface.js';

/**
 * Handles one command class. `TResult` defaults to the result type of a `Command<TResult>`, and to `any` for a plain
 * command class.
 */
export interface ICommandHandler<TCommand extends ICommand = any, TResult = ResultOf<TCommand>> {
	execute(command: TCommand): Promise<TResult>;
}
