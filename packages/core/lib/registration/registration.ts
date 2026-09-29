/**
 * The injection token of the module's registration. The `EventMap` and the buses inject it by this token rather than by
 * class, because the registrar itself looks them up: a class token would make their files import each other.
 * @internal Not exported from the package.
 */
export const EVENT_SOURCING_REGISTRATION = 'EventSourcingRegistration';

/**
 * Registers the events, serializers, handlers, subscribers and publishers of the application once (ADR 0001 §3).
 * @internal Not exported from the package.
 */
export interface Registration {
	/**
	 * Registers everything unless that happened already. The `EventMap` and the buses call it on their first use, since a
	 * provider of another module may use them before the module's own `onModuleInit` runs.
	 *
	 * @param operation what triggered it, for the error message
	 * @throws EventSourcingNotReadyException while Nest is still instantiating the providers
	 * @throws EventSourcingConfigurationException listing every problem with the configuration
	 */
	ensureRegistered(operation?: string): void;

	/**
	 * Registers everything unless that happened already, without checking that the providers are instantiated: the
	 * module calls it from `onModuleInit`, when Nest has instantiated every provider.
	 *
	 * @throws EventSourcingConfigurationException listing every problem with the configuration
	 */
	initialize(): void;
}
