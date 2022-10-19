import { Type } from '@nestjs/common';
import { IEvent } from '@ocoda/event-sourcing/interfaces';
import { EventEnvelope } from '@ocoda/event-sourcing/models';
import { Observable } from 'rxjs';
import { filter } from 'rxjs/operators';
import { getEventMetadata } from '../metadata';

/**
 * Filter observables by event name
 *
 * @param types List of types implementing `IEvent`.
 *
 * @return A stream only emitting the filtered instances.
 */
export function eventFilter<TInput extends EventEnvelope, TOutput extends EventEnvelope>(...types: Type<IEvent>[]) {
	const isEnvelopeOfEvent = (envelope: EventEnvelope): envelope is TOutput =>
		types.find((classType) => {
			const { name } = getEventMetadata(classType);
			return envelope.event === name;
		}) !== undefined;
	return (source: Observable<TInput>): Observable<TOutput> => source.pipe(filter(isEnvelopeOfEvent));
}
