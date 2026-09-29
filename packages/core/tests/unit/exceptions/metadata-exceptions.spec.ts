import {
	MissingEventPublisherMetadataException,
	MissingEventSerializerMetadataException,
	MissingSnapshotMetadataException,
} from '@ocoda/event-sourcing';

describe('metadata exceptions', () => {
	it('formats MissingEventPublisherMetadataException', () => {
		const exception = new MissingEventPublisherMetadataException({ publisher: class ExamplePublisher {} });

		expect(exception.message).toContain('ExamplePublisher');
	});

	it('formats MissingEventSerializerMetadataException', () => {
		const exception = new MissingEventSerializerMetadataException({ serializer: class ExampleSerializer {} });

		expect(exception.message).toContain('ExampleSerializer');
	});

	it('formats MissingSnapshotMetadataException', () => {
		const exception = new MissingSnapshotMetadataException({ repository: class ExampleSnapshotRepository {} });

		expect(exception.message).toContain('ExampleSnapshotRepository');
	});
});
