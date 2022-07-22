import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CommandBus } from '@ocoda/event-sourcing';
import { FooCommand } from '../src/foo.command';
import { AppModule } from '../src/app.module';
import { QueryBus } from '@ocoda/event-sourcing/query-bus';
import { FooQuery } from '../src/bar.query';

describe('EventSourcingModule - e2e', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
  });

  it(`should make the "foo-command-handler" execute the "foo" command`, async () => {
    await app.init();

    const commandBus = app.get<CommandBus>(CommandBus);

    const command = new FooCommand();

    await expect(commandBus.execute(command)).resolves.toEqual(true);
  });

  it(`should make the "foo-query-handler" execute the "foo" query`, async () => {
    await app.init();

    const queryBus = app.get<QueryBus>(QueryBus);

    const query = new FooQuery();

    await expect(queryBus.execute(query)).resolves.toEqual({ foo: 'bar' });
  });

  afterEach(async () => {
    await app.close();
  });
});
