import { Type } from '@nestjs/common';
import { IEvent } from '@ocoda/event-sourcing/interfaces';
import { Observable } from 'rxjs';
import { filter } from 'rxjs/operators';

/**
 * Filter observables by instance type
 *
 * @param types List of types implementing `IEvent`.
 *
 * @return A stream only emitting the filtered instances.
 */
export function typeFilter<TInput extends IEvent, TOutput extends IEvent>(...types: Type<TOutput>[]) {
	const isInstanceOf = (event: IEvent): event is TOutput =>
		types.find((classType) => event instanceof classType) !== undefined;
	return (source: Observable<TInput>): Observable<TOutput> => source.pipe(filter(isInstanceOf));
}
