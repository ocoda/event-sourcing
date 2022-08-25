import { instanceToPlain, plainToInstance } from 'class-transformer';
import { Type } from '@nestjs/common';
import { ISnapshot, ISnapshotSerializer } from '../interfaces';
import { Aggregate } from '../models';

export class DefaultSnapshotSerializer<A extends Aggregate = Aggregate>
  implements ISnapshotSerializer
{
  private constructor(private readonly snapshotType: Type<A>) {}

  static for<A extends Aggregate = Aggregate>(
    cls: Type<A>,
  ): DefaultSnapshotSerializer<A> {
    return new DefaultSnapshotSerializer(cls);
  }

  serialize(cls: A): ISnapshot<A> {
    return instanceToPlain(cls) as ISnapshot<A>;
  }

  deserialize(payload: ISnapshot<A>): A {
    return plainToInstance<A, ISnapshot<A>>(this.snapshotType, payload);
  }
}
