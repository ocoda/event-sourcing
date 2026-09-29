import { Inject } from '@nestjs/common';
// The token itself, not getOptionsToken() from the providers, which import the EventBus: the bus imports the helpers,
// which import the decorators
import { EVENT_SOURCING_OPTIONS } from '../constants.js';

/**
 * Decorator that injects the options used to configure the EventSourcingModule.
 * @returns {EventSourcingModuleOptions}
 * @example `@InjectEventSourcingOptions() options: EventSourcingModuleOptions`
 */
export const InjectEventSourcingOptions = () => Inject(EVENT_SOURCING_OPTIONS);
