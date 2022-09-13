import { AggregateMetadata } from '../interfaces';
import 'reflect-metadata';
import { AGGREGATE_METADATA } from './constants';
import { AggregateRoot } from '../models';
import { Type } from '@nestjs/common';

/**
 * Decorator that provides an aggregate with metadata.
 *
 * The decorated class must extend the `AggregateRoot` class.
 */
export const Aggregate = (options?: AggregateMetadata): ClassDecorator => {
	return (target: object) => {
		const { name } = target as Type<AggregateRoot>;
		const metadata: AggregateMetadata = { streamName: name.toLowerCase(), ...options };

		Reflect.defineMetadata(AGGREGATE_METADATA, metadata, target);
	};
};
