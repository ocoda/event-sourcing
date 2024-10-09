import type { Type } from '@nestjs/common';
import 'reflect-metadata';
import { InvalidAggregateStreamNameException } from '../exceptions';
import type { AggregateMetadata } from '../interfaces';
import type { AggregateRoot } from '../models';
import { AGGREGATE_METADATA } from './constants';

/**
 * Decorator that provides an aggregate with metadata.
 * @description The decorated class must extend the `AggregateRoot` class.
 * @param {AggregateMetadata} options The metadata for the aggregate.
 * @returns {ClassDecorator}
 * @example `@Aggregate('account')` or `@Aggregate({ streamName: 'account' })`
 */
export const Aggregate = (options?: AggregateMetadata): ClassDecorator => {
	return (target: object) => {
		const { name } = target as Type<AggregateRoot>;
		const metadata: AggregateMetadata = { streamName: name.toLowerCase(), ...options };

		if (metadata.streamName.length > 50) {
			throw InvalidAggregateStreamNameException.becauseExceedsMaxLength(name, 50);
		}

		Reflect.defineMetadata(AGGREGATE_METADATA, metadata, target);
	};
};
