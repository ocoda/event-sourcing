import { Type } from '@nestjs/common';
import { Aggregate } from './aggregate';
import { Id } from './id';

declare const __aggregate__: unique symbol;

export class SnapshotStream<A extends Aggregate = Aggregate> extends String {
  readonly [__aggregate__]: A;

  static for<A extends Aggregate = Aggregate>(aggregate: A | Type<A>, id: Id) {
    const className =
      aggregate instanceof Function
        ? aggregate.name
        : aggregate.constructor.name;
    return `${className}-${id.value}`;
  }
}
