import type { Type } from '@nestjs/common';
import 'reflect-metadata';
import { InvalidAggregateStreamNameException } from '../exceptions/index.js';
import type { AggregateMetadata } from '../interfaces/index.js';
import type { AggregateRoot } from '../models/index.js';
import { AGGREGATE_METADATA } from './constants.js';

/**
 * Decorator that provides an aggregate with metadata.
 * @description The decorated class must extend the `AggregateRoot` class.
 * @param {AggregateMetadata} options The metadata for the aggregate: the `streamName` (the lower-cased class name by
 * default) and what `applyEvent()` does with an event that has no handler, `missingHandler` (`'throw'` by default).
 * @returns {ClassDecorator}
 * @example `@Aggregate()`, `@Aggregate({ streamName: 'account' })` or `@Aggregate({ missingHandler: 'ignore' })`
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
