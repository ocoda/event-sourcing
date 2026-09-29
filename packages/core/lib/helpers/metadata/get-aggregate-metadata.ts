import type { Type } from '@nestjs/common';
import { AGGREGATE_METADATA } from '../../decorators/index.js';
import type { AggregateMetadata } from '../../interfaces/index.js';
import type { AggregateRoot } from '../../models/index.js';

export const getAggregateMetadata = (cls: Type<AggregateRoot>): AggregateMetadata => {
	return Reflect.getMetadata(AGGREGATE_METADATA, cls) ?? {};
};
