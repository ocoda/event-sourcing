import {
	AggregateRepositories as CatalogueAggregateRepositories,
	CommandHandlers as CatalogueCommandHandlers,
	Controllers as CatalogueControllers,
	Events as CatalogueEvents,
	QueryHandlers as CatalogueQueryHandlers,
	SnapshotRepositories as CatalogueSnapshotRepositories,
} from './catalogue/catalogue.providers';
import {
	AggregateRepositories as LoaningAggregateRepositories,
	CommandHandlers as LoaningCommandHandlers,
	Controllers as LoaningControllers,
	Events as LoaningEvents,
	QueryHandlers as LoaningQueryHandlers,
	SnapshotRepositories as LoaningSnapshotRepositories,
} from './loaning/loaning.providers';

export { DomainExceptionsFilter } from './loaning/application/exceptions/exception.filter';

export const AggregateRepositories = [...CatalogueAggregateRepositories, ...LoaningAggregateRepositories];
export const CommandHandlers = [...CatalogueCommandHandlers, ...LoaningCommandHandlers];
export const Controllers = [...CatalogueControllers, ...LoaningControllers];
export const Events = [...CatalogueEvents, ...LoaningEvents];
export const QueryHandlers = [...CatalogueQueryHandlers, ...LoaningQueryHandlers];
export const SnapshotRepositories = [...CatalogueSnapshotRepositories, ...LoaningSnapshotRepositories];
