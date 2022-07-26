import { Id } from '../../id';

export class IdAlreadyRegisteredError extends Error {
  public static withId(id: Id): IdAlreadyRegisteredError {
    return new IdAlreadyRegisteredError(`Id ${id.value} already taken.`);
  }
}
