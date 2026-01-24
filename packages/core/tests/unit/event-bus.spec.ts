import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import {
	EventBus,
	EventSubscriber,
	MissingEventMetadataException,
	MissingEventSubscriberMetadataException,
} from '@ocoda/event-sourcing';
import { EVENT_SUBSCRIBER_METADATA } from '@ocoda/event-sourcing/decorators';

describe(EventBus, () => {
	class EventWithoutMetadata {}

	@EventSubscriber(EventWithoutMetadata as any)
	class SubscriberWithMissingEventMetadata {
		handle() {
			return;
		}
	}

	class SubscriberWithoutMetadata {
		handle() {
			return;
		}
	}

	it('throws when registering subscriber without instance or metatype', () => {
		const bus = new EventBus();
		const wrapper = { metatype: { name: 'MissingSubscriber' }, instance: {} } as unknown as InstanceWrapper;

		expect(() => bus.registerSubscribers([wrapper])).toThrow(MissingEventSubscriberMetadataException);
	});

	it('throws when subscriber metadata is missing', () => {
		const bus = new EventBus();
		const wrapper = {
			metatype: SubscriberWithoutMetadata,
			instance: new SubscriberWithoutMetadata(),
		} as unknown as InstanceWrapper;

		expect(() => bus.registerSubscribers([wrapper])).toThrow(MissingEventSubscriberMetadataException);
	});

	it('throws when event metadata is missing for subscriber events', () => {
		const bus = new EventBus();
		Reflect.defineMetadata(
			EVENT_SUBSCRIBER_METADATA,
			{ events: [EventWithoutMetadata] },
			SubscriberWithMissingEventMetadata,
		);
		const wrapper = {
			metatype: SubscriberWithMissingEventMetadata,
			instance: new SubscriberWithMissingEventMetadata(),
		} as unknown as InstanceWrapper;

		expect(() => bus.registerSubscribers([wrapper])).toThrow(MissingEventMetadataException);
	});
});
