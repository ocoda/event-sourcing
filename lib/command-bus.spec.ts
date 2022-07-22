import { Test } from '@nestjs/testing';
import { CommandBus } from './command-bus';
import { CommandHandler } from './decorators';
import { EventSourcingModule } from './event-sourcing.module';
import { ICommand, ICommandHandler } from './interfaces';

describe(CommandBus, () => {
  let commandBus: CommandBus;
  const mockedExecute = jest.fn();

  class TestCommand implements ICommand {
    public readonly foo = 'bar';
  }

  @CommandHandler(TestCommand)
  class TestCommandHandler implements ICommandHandler {
    execute = mockedExecute;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventSourcingModule.forRoot()],
      providers: [TestCommandHandler],
    }).compile();

    commandBus = moduleRef.get<CommandBus>(CommandBus);
    commandBus.register([TestCommandHandler]);
  });

  it('executes the command with the decorated command-handler', async () => {
    const command = new TestCommand();
    await commandBus.execute(command);

    expect(mockedExecute).toHaveBeenCalledWith(command);
  });
});
