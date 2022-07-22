import { IQuery } from '../interfaces';
import 'reflect-metadata';
import { QUERY_HANDLER_METADATA, QUERY_METADATA } from './constants';
import { randomUUID } from 'crypto';

/**
 * Decorator that marks a class as a query handler. A query handler
 * handles queries executed by your application code.
 *
 * The decorated class must implement the `IQueryHandler` interface.
 *
 * @param query query *type* to be handled by this handler.
 */
export const QueryHandler = (query: IQuery): ClassDecorator => {
  return (target: object) => {
    if (!Reflect.hasMetadata(QUERY_METADATA, query)) {
      Reflect.defineMetadata(QUERY_METADATA, { id: randomUUID() }, query);
    }
    Reflect.defineMetadata(QUERY_HANDLER_METADATA, query, target);
  };
};
