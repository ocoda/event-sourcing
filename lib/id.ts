import { randomUUID } from 'crypto';

import { InvalidIdError } from './exceptions';
import { ValueObject } from './value-object';

interface Props {
  value: string;
}

export abstract class Id extends ValueObject<Props> {
  protected constructor(id: string = randomUUID()) {
    if (typeof id !== 'string') {
      throw InvalidIdError.withString('Id is not a string');
    }
    super({ value: id });
  }

  get value(): string {
    return this.props.value;
  }
}
