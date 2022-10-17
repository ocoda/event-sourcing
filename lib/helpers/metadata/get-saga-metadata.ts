import { Type } from '@nestjs/common';
import { SAGA_METADATA } from '../../decorators';
import { ISaga, SagaMetadata } from '../../interfaces';

export const getSagaMetadata = (saga: Type<ISaga>): SagaMetadata => {
	return Reflect.getMetadata(SAGA_METADATA, saga) ?? [];
};
