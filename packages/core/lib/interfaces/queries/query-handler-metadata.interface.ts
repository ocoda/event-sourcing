import type { Type } from '@nestjs/common';
import type { IQuery } from './query.interface';

export interface QueryHandlerMetadata {
	query: Type<IQuery>;
}
