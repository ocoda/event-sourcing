import { Aggregate } from '../../models';

type AggregatePropertyNames<T> = {
  [Key in keyof T]: T[Key] extends Function ? never : Key;
}[keyof T];

export type ISnapshot<
  TAggregate extends Aggregate,
  TDerivedAggregate = Omit<TAggregate, keyof Aggregate>,
> = {
  [Key in AggregatePropertyNames<TDerivedAggregate>]: TDerivedAggregate[Key] extends Function
    ? never
    : TDerivedAggregate[Key];
};

export type ISnapshotPayload<TAggregate extends Aggregate> = Record<
  keyof ISnapshot<TAggregate>,
  any
>;
