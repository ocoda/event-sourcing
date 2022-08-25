import { Aggregate } from '@ocoda/event-sourcing/models';

export type ISnapshot<A extends Aggregate = Aggregate> = {
  [key in keyof A]: any;
};
