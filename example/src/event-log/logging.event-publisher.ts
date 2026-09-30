import { Logger } from '@nestjs/common';
import { type EventEnvelope, EventPublisher, type IEventPublisher } from '@ocoda/event-sourcing';

/**
 * Receives every event once it is stored, next to the default publisher that feeds the subscribers. This one logs them;
 * a real publisher sends them to a broker such as Kafka or SNS. `appendEvents` waits for it, so keep it fast.
 */
@EventPublisher()
export class LoggingEventPublisher implements IEventPublisher {
	private readonly logger = new Logger('Events');

	async publish({ event, metadata }: EventEnvelope): Promise<void> {
		this.logger.log(`#${metadata.globalPosition} ${event} (${metadata.aggregateId} v${metadata.version})`);
	}
}
