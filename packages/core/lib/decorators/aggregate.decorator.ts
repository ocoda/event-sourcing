import type { Type } from '@nestjs/common';
import 'reflect-metadata';
import { InvalidAggregateStreamNameException } from '../exceptions/index.js';
import type { AggregateMetadata } from '../interfaces/index.js';
import type { AggregateRoot } from '../models/index.js';
import { AGGREGATE_METADATA } from './constants.js';

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

		if ((metadata.streamName?.length || 0) > 50) {
			throw new InvalidAggregateStreamNameException({
				aggregate: name,
				streamName: metadata.streamName,
				maxLength: 50,
			});
		}

		Reflect.defineMetadata(AGGREGATE_METADATA, metadata, target);
	};
};
