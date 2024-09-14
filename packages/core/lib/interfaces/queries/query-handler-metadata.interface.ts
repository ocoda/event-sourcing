import { Type } from '@nestjs/common';
import { IQuery } from './query.interface';

export interface QueryHandlerMetadata {
	query: Type<IQuery>;
}
