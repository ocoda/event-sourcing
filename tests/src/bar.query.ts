import { IQuery, IQueryHandler, QueryHandler } from '@ocoda/event-sourcing';

export class FooQuery implements IQuery {}

@QueryHandler(FooQuery)
export class FooQueryHandler implements IQueryHandler {
  async execute(): Promise<{ foo: string }> {
    return Promise.resolve({ foo: 'bar' });
  }
}
