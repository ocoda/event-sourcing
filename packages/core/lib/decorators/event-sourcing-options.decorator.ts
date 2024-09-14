import { Inject } from '@nestjs/common';
import { getOptionsToken } from '../event-sourcing.providers';

/**
 * Sets the proper injection token for the `EVENT_SOURCING_OPTIONS`
 * @usage @InjectEventSourcingOptions()
 * @publicApi
 */
export const InjectEventSourcingOptions = () => Inject(getOptionsToken());
