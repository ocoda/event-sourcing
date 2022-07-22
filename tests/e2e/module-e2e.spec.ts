import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CommandBus, EventListener } from '@ocoda/event-sourcing';
import { FooCommand } from '../src/foo.command';
import { AppModule } from '../src/app.module';
import { QueryBus } from '@ocoda/event-sourcing/query-bus';
import { FooEvent } from '../src/foo.event';
import { BarEventHandler } from '../src/bar.event-handler';
import { FooEventHandler } from '../src/foo.event-handler';
import { EventPublisher } from '@ocoda/event-sourcing/event-publisher';
import { FooQuery } from '../src/foo.query';
import { EventEmitter2 } from '@nestjs/event-emitter';

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

  it(`should make any method listening to the "foo-event" handle it`, async () => {
    const fooHandling = jest.fn((event) => event);
    const barHandling = jest.fn((event) => event);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      providers: [
        {
          provide: FooEventHandler,
          useFactory: () => new FooEventHandler(fooHandling),
        },
        {
          provide: BarEventHandler,
          useFactory: () => new BarEventHandler(barHandling),
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    const event = new FooEvent();
    const eventPublisher = app.get<EventPublisher>(EventPublisher);

    eventPublisher.publish(event);

    expect(fooHandling).toHaveBeenCalled();
    expect(barHandling).toHaveBeenCalled();
  });

  afterEach(async () => {
    await app.close();
  });
});
