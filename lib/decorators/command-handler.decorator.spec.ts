import { ICommand } from '../interfaces';
import { CommandHandler } from './command-handler.decorator';
import { COMMAND_HANDLER_METADATA, COMMAND_METADATA } from './constants';

describe('@CommandHandler', () => {
  class TestCommand implements ICommand {}

  @CommandHandler(TestCommand)
  class TestCommandHandler {}

  it('should specify which command the command-handler handles', () => {
    const command: ICommand = Reflect.getMetadata(
      COMMAND_HANDLER_METADATA,
      TestCommandHandler,
    );
    expect(command).toEqual(TestCommand);

    const commandMetadata = Reflect.getMetadata(COMMAND_METADATA, command);
    expect(commandMetadata.id).toBeDefined();
  });
});
