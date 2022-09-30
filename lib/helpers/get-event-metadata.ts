import { EVENT_METADATA } from '../decorators';
import { EventType } from '../event-bus';
import { MissingEventMetadataException } from '../exceptions';
import { EventMetadata } from '../interfaces';

export const getEventMetadata = (event: EventType): EventMetadata => {
	const metadata = Reflect.getMetadata(EVENT_METADATA, event);
	if (!metadata) {
		throw new MissingEventMetadataException(event);
	}
	return metadata;
};
