import { Type } from '@nestjs/common';
import { AGGREGATE_METADATA } from '../../decorators';
import { AggregateMetadata } from '../../interfaces';
import { AggregateRoot } from '../../models';

export const getAggregateMetadata = (cls: Type<AggregateRoot>): AggregateMetadata => {
	return Reflect.getMetadata(AGGREGATE_METADATA, cls) ?? {};
};
