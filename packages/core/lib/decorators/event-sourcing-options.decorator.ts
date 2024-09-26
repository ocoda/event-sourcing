import { Inject } from '@nestjs/common';
import { getOptionsToken } from '../event-sourcing.providers';

/**
 * Decorator that injects the options used to configure the EventSourcingModule.
 * @returns {EventSourcingModuleOptions}
 * @example `@InjectEventSourcingOptions() options: EventSourcingModuleOptions`
 */
export const InjectEventSourcingOptions = () => Inject(getOptionsToken());
