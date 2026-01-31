import {
	MissingEventPublisherMetadataException,
	MissingEventSerializerMetadataException,
	MissingSnapshotMetadataException,
} from '@ocoda/event-sourcing';

describe('metadata exceptions', () => {
	it('formats MissingEventPublisherMetadataException', () => {
		const exception = new MissingEventPublisherMetadataException(class ExamplePublisher {} as any);

		expect(exception.message).toContain('ExamplePublisher');
	});

	it('formats MissingEventSerializerMetadataException', () => {
		const exception = new MissingEventSerializerMetadataException(class ExampleSerializer {} as any);

		expect(exception.message).toContain('ExampleSerializer');
	});

	it('formats MissingSnapshotMetadataException', () => {
		const exception = new MissingSnapshotMetadataException(class ExampleSnapshotRepository {} as any);

		expect(exception.message).toContain('ExampleSnapshotRepository');
	});
});
