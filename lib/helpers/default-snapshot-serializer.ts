import { instanceToPlain, plainToInstance } from 'class-transformer';
import { Type } from '@nestjs/common';
import { ISnapshot, ISnapshotSerializer } from '../interfaces';

export class DefaultSnapshotSerializer<E extends ISnapshot = ISnapshot>
  implements ISnapshotSerializer
{
  private constructor(private readonly snapshotType: Type<E>) {}

  static for<E extends ISnapshot = ISnapshot>(
    cls: Type<E>,
  ): DefaultSnapshotSerializer<E> {
    return new DefaultSnapshotSerializer(cls);
  }

  serialize(snapshot: ISnapshot): Record<string, any> {
    return instanceToPlain(snapshot);
  }

  deserialize(payload: Record<string, any>): E {
    return plainToInstance<E, Record<string, any>>(this.snapshotType, payload);
  }
}
