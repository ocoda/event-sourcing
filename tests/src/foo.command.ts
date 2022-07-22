import {
  CommandHandler,
  ICommand,
  ICommandHandler,
} from '@ocoda/event-sourcing';

export class FooCommand implements ICommand {
  public readonly foo = 'bar';
}

@CommandHandler(FooCommand)
export class FooCommandHandler implements ICommandHandler {
  async execute(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
