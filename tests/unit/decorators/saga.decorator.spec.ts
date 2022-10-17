import { map, Observable } from 'rxjs';
import { ICommand, IEvent, Saga } from '../../../lib';
import { getSagaMetadata, typeFilter } from '../../../lib/helpers';

describe('@Saga', () => {
	class FooCreatedEvent implements IEvent {}
	class FooDeletedEvent implements IEvent {}

	class BarCommand implements ICommand {}

	class FooSagas {
		@Saga()
		fooCreated = (events$: Observable<any>): Observable<ICommand> => {
			return events$.pipe(
				typeFilter(FooCreatedEvent),
				map(() => new BarCommand()),
			);
		};
		@Saga()
		fooDeleted = (events$: Observable<any>): Observable<ICommand> => {
			return events$.pipe(
				typeFilter(FooDeletedEvent),
				map(() => new BarCommand()),
			);
		};
	}

	it('should determine the name of an event from the constructor', () => {
		const sagas = getSagaMetadata(FooSagas);
		expect(sagas).toEqual(['fooCreated', 'fooDeleted']);
	});
});
