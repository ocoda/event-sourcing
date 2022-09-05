import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CommandBus, ICommandBus } from '@ocoda/event-sourcing';
import { AppModule } from '../src/app.module';
import { OpenAccountCommand } from '../src/application/commands';

describe('EventSourcingModule - e2e', () => {
  let app: INestApplication;
  let commandBus: ICommandBus;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    commandBus = app.get<CommandBus>(CommandBus);
  });

  afterAll(async () => await app.close());

  it(`should open an account`, async () => {
    const command = new OpenAccountCommand();
    await commandBus.execute(command);
  });
});
