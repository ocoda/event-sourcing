import { ISnapshot } from './snapshot.interface';

export interface ISnapshotSerializer<
  BaseSnapshot extends ISnapshot = ISnapshot,
  Payload extends Record<string, unknown> = Record<string, unknown>,
> {
  serialize: (snapshot: BaseSnapshot) => Payload;
  deserialize: (payload: Payload, ...params) => BaseSnapshot;
}
