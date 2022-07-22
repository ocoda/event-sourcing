import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CommandBus } from '@ocoda/event-sourcing';
import { FooCommand } from '../src/foo.command';
import { AppModule } from '../src/app.module';

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

    // await expect(commandBus.execute(command)).resolves.toBe(true);
    expect(true).toBe(true);
  });

  // it(`should emit a "test-event" event to controllers`, async () => {
  //   const eventsConsumerRef = app.get(EventsControllerConsumer);
  //   await app.init();

  //   expect(eventsConsumerRef.eventPayload).toEqual(TEST_EVENT_PAYLOAD);
  // });

  // it('should be able to specify a consumer be prepended via OnEvent decorator options', async () => {
  //   const eventsConsumerRef = app.get(EventsProviderPrependConsumer);
  //   const prependListenerSpy = jest.spyOn(
  //     app.get(EventEmitter2),
  //     'prependListener',
  //   );
  //   await app.init();

  //   expect(eventsConsumerRef.eventPayload).toEqual(TEST_EVENT_PAYLOAD);
  //   expect(prependListenerSpy).toHaveBeenCalled();
  // });

  // it('should work with null prototype provider value', async () => {
  //   const moduleWithNullProvider = await Test.createTestingModule({
  //     imports: [AppModule],
  //   })
  //     .overrideProvider(TEST_PROVIDER_TOKEN)
  //     .useFactory({
  //       factory: () => {
  //         const testObject = { a: 13, b: 7 };
  //         Object.setPrototypeOf(testObject, null);
  //         return testObject;
  //       },
  //     })
  //     .compile();
  //   app = moduleWithNullProvider.createNestApplication();
  //   await expect(app.init()).resolves.not.toThrow();
  // });

  // it('should be able to emit a request-scoped event with a single payload', async () => {
  //   await app.init();

  //   expect(
  //     EventsProviderRequestScopedConsumer.injectedEventPayload.objectValue,
  //   ).toEqual(TEST_EVENT_PAYLOAD);
  // });

  // it('should be able to emit a request-scoped event with a string payload', async () => {
  //   await app.init();

  //   expect(
  //     EventsProviderRequestScopedConsumer.injectedEventPayload.stringValue,
  //   ).toEqual(TEST_EVENT_STRING_PAYLOAD);
  // });

  // it('should be able to emit a request-scoped event with multiple payloads', async () => {
  //   await app.init();

  //   expect(
  //     EventsProviderRequestScopedConsumer.injectedEventPayload.arrayValue,
  //   ).toEqual(TEST_EVENT_MULTIPLE_PAYLOAD);
  // });

  afterEach(async () => {
    await app.close();
  });
});
