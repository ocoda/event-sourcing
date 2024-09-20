import type { Subject } from 'rxjs';
import type { ICommand, ICommandPublisher } from '../interfaces';

export class DefaultCommandPubSub<CommandBase extends ICommand> implements ICommandPublisher<CommandBase> {
	constructor(private subject$: Subject<CommandBase>) {}

	publish<T extends CommandBase>(command: T) {
		this.subject$.next(command);
	}
}
