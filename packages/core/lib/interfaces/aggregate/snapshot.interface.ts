import { AggregateRoot } from '../../models';

type AggregatePropertyNames<T> = {
	// biome-ignore lint/complexity/noBannedTypes:
	[Key in keyof T]: T[Key] extends Function ? never : Key;
}[keyof T];

export type ISnapshot<TAggregate extends AggregateRoot, TDerivedAggregate = Omit<TAggregate, keyof AggregateRoot>> = {
	// biome-ignore lint/complexity/noBannedTypes:
	[Key in AggregatePropertyNames<TDerivedAggregate>]: TDerivedAggregate[Key] extends Function ? never : any;
};
