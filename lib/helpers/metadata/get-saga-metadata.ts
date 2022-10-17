import { Type } from '@nestjs/common';
import { SAGA_METADATA } from '../../decorators';
import { SagaMetadata } from '../../interfaces';

export const getSagaMetadata = (sagaHandler: Type<any>): SagaMetadata => {
	return Reflect.getMetadata(SAGA_METADATA, sagaHandler) ?? [];
};
