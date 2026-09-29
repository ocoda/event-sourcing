import { EventSourcingError, EventSourcingErrorCode } from '../event-sourcing-error.js';

/**
 * What is wrong with the configuration, one kind per check the bootstrap runs:
 *
 * - `invalid-options`: module options that can't work, such as `forRootAsync()` without `useFactory`, `useClass` or
 *   `useExisting`, a store config without a `driver` class, an entry of `events` that is not a class, or a
 *   `defaultEventSerializer` without a `for()` method.
 * - `missing-metadata`: a class lacks the metadata of its decorator: an event without `@Event()`, a serializer passed
 *   to `forFeature({ serializers })` without `@EventSerializer()`, a handler whose decorator names no message class,
 *   or a subscriber that names no events.
 * - `duplicate-event-name`: two event classes share one event name.
 * - `duplicate-command-handler`, `duplicate-query-handler`, `duplicate-event-serializer`: two classes handle the same
 *   command or query, or serialize the same event. Registering one class more than once is not a duplicate.
 * - `unregistered-event`: a serializer or subscriber for an event that no `events` option registers.
 * - `non-static-provider`: a request-scoped or transient event subscriber, publisher or serializer. These live as long
 *   as the application, so they must be singletons; command and query handlers may be request-scoped.
 * - `class-transformer-decorators`: an event class, or a parent class, with class-transformer decorators (`@Type`,
 *   `@Transform`, `@Expose` or `@Exclude`) that would get the default `JsonEventSerializer`, which ignores them.
 *   Found only when class-transformer is installed.
 */
export type EventSourcingConfigurationIssueKind =
	| 'invalid-options'
	| 'missing-metadata'
	| 'duplicate-event-name'
	| 'duplicate-command-handler'
	| 'duplicate-query-handler'
	| 'duplicate-event-serializer'
	| 'unregistered-event'
	| 'non-static-provider'
	| 'class-transformer-decorators';

/**
 * One problem with the configuration of the `EventSourcingModule`.
 */
export interface EventSourcingConfigurationIssue {
	readonly kind: EventSourcingConfigurationIssueKind;
	/** What is wrong and how to fix it, naming the classes involved. */
	readonly message: string;
}

/**
 * Thrown when the application bootstraps with a configuration of the `EventSourcingModule` that can't work, such as
 * two handlers for one command or a subscriber for an event that isn't registered. It lists every problem it found in
 * `issues`, so that one bootstrap reports all of them.
 */
export class EventSourcingConfigurationException extends EventSourcingError {
	override readonly name = 'EventSourcingConfigurationException';
	readonly code = EventSourcingErrorCode.EventSourcingConfiguration;
	/** Every problem found, in the order in which they were found. */
	readonly issues: readonly EventSourcingConfigurationIssue[];

	constructor(details: { issues: readonly EventSourcingConfigurationIssue[] }, options?: ErrorOptions) {
		const issues = Object.freeze([...(Array.isArray(details?.issues) ? details.issues : [])]);
		const count = issues.length === 1 ? '1 issue' : `${issues.length} issues`;
		super(
			`Invalid EventSourcingModule configuration (${count})${issues.map((issue) => `\n- [${issue?.kind}] ${issue?.message}`).join('')}`,
			options,
		);
		this.issues = issues;
	}
}
