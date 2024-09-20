import { Logger } from '@nestjs/common';
// biome-ignore lint/style/useImportType: DI
import { EventMap } from './event-map';
import type { EventSourcingModuleOptions, EventStoreDriver, IEvent, IEventCollection, IEventPool } from './interfaces';
import type { EventEnvelope, EventStream } from './models';

export abstract class EventStore<TOptions = Omit<EventSourcingModuleOptions['eventStore'], 'driver'>>
	implements EventStoreDriver
{
	protected readonly logger = new Logger(this.constructor.name);
	protected _publish: (envelope: EventEnvelope<IEvent>) => any;

	constructor(
		protected readonly eventMap: EventMap,
		protected readonly options: TOptions,
	) {
		// biome-ignore lint/correctness/noConstructorReturn:
		return new Proxy(this, {
			get(target, propKey) {
				if (propKey === 'appendEvents') {
					return async function (...args: unknown[]) {
						const envelopes = await target[propKey].apply(this, args);
						for (const envelope of envelopes) {
							await this._publish(envelope);
						}
						return envelopes;
					};
				}
				return target[propKey];
			},
		});
	}

	set publish(fn: (envelope: EventEnvelope<IEvent>) => any) {
		this._publish = fn;
	}

	public abstract connect(): void | Promise<void>;
	public abstract disconnect(): void | Promise<void>;

	public abstract ensureCollection(pool?: string): IEventCollection | Promise<unknown>;

	abstract getEvents(eventStream: EventStream, filter?: IEventFilter): AsyncGenerator<IEvent[]>;
	abstract getEvent(eventStream: EventStream, version: number, pool?: IEventPool): IEvent | Promise<IEvent>;
	abstract appendEvents(
		eventStream: EventStream,
		version: number,
		events: IEvent[],
		pool?: IEventPool,
	): Promise<EventEnvelope[]>;
	abstract getEnvelopes?(eventStream: EventStream, filter?: IEventFilter): AsyncGenerator<EventEnvelope[]>;
	abstract getEnvelope?(
		eventStream: EventStream,
		version: number,
		pool?: IEventPool,
	): EventEnvelope | Promise<EventEnvelope>;
}
