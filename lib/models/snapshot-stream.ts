import { Type } from '@nestjs/common';
import { Aggregate } from './aggregate';
import { Id } from './id';

export class SnapshotStream extends String {
  static for(aggregate: Aggregate | Type<Aggregate>, id: Id) {
    const className =
      aggregate instanceof Function
        ? aggregate.name
        : aggregate.constructor.name;
    return `${className}-${id.value}`;
  }
}
