import { EventEnvelope } from '../../models';

export interface IEventHandler {
	handle(envelope: EventEnvelope): any;
}
