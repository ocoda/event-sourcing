import { Aggregate } from '@ocoda/event-sourcing/models';

export type ISnapshot<A extends Aggregate, D = Omit<A, keyof Aggregate>> = {
  [key in keyof D]: any;
};
