import { Schema } from 'redis-om';

export const snapshotSchema = new Schema('snapshot', {
	id: { type: 'string' },
	streamId: { type: 'string' },
	payload: { type: 'string' },
	aggregateName: { type: 'string' },
	snapshotId: { type: 'string' },
	aggregateId: { type: 'string' },
	version: { type: 'number' },
	registeredOn: { type: 'date' },
});
