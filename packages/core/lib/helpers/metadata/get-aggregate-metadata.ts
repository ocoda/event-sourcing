import type { Type } from '@nestjs/common';
import { AGGREGATE_METADATA } from '../../decorators';
import type { AggregateMetadata } from '../../interfaces';
import type { AggregateRoot } from '../../models';

export const getAggregateMetadata = (cls: Type<AggregateRoot>): AggregateMetadata => {
	return Reflect.getMetadata(AGGREGATE_METADATA, cls) ?? {};
};
