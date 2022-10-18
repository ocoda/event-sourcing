import { Injectable, OnModuleDestroy, Type } from '@nestjs/common';
import { from, Subscription } from 'rxjs';
import { filter, mergeMap } from 'rxjs/operators';
import { getEventMetadata, ObservableBus } from './helpers';
import { DefaultEventPubSub } from './helpers/default-event-publisher';
import { IEvent, IEventBus, IEventHandler, IEventPublisher } from './interfaces';

export type EventHandlerType<EventBase extends IEvent = IEvent> = Type<IEventHandler<EventBase>>;

@Injectable()
export class EventBus<EventBase extends IEvent = IEvent>
	extends ObservableBus<EventBase>
	implements IEventBus<EventBase>, OnModuleDestroy
{
	protected readonly subscriptions: Subscription[] = [];
	private _publisher: IEventPublisher<EventBase> = new DefaultEventPubSub<EventBase>(this.subject$);

	get publisher(): IEventPublisher<EventBase> {
		return this._publisher;
	}

	set publisher(_publisher: IEventPublisher<EventBase>) {
		this._publisher = _publisher;
	}

	onModuleDestroy() {
		this.subscriptions.forEach((subscription) => subscription.unsubscribe());
	}

	publish = <T extends EventBase>(event: T) => this._publisher.publish(event, this.subject$);

	publishAll = <T extends EventBase>(events: T[]) =>
		(events || []).map((event) => this._publisher.publish(event, this.subject$));

	bind(handler: IEventHandler<EventBase>, id: string) {
		const stream$ = id ? this.ofEventId(id) : this.subject$;
		const subscription = stream$.pipe(mergeMap((event) => from(Promise.resolve(handler.handle(event))))).subscribe({
			error: (error) => {
				throw error;
			},
		});
		this.subscriptions.push(subscription);
	}

	protected ofEventId(eventId: string) {
		return this.subject$.pipe(
			filter((event) => {
				const { id } = getEventMetadata(Object.getPrototypeOf(event));
				console.log({ event, id });
				return id === eventId;
			}),
		);
	}
}
