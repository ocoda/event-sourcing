import { SAGA_METADATA } from '../../decorators';
import { ISaga, SagaMetadata } from '../../interfaces';

export const getSagaMetadata = (saga: ISaga): SagaMetadata => {
	return Reflect.getMetadata(SAGA_METADATA, saga) ?? [];
};
