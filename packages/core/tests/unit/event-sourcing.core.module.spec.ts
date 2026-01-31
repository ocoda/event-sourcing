import { EventSourcingCoreModule } from '../../lib/event-sourcing.core.module';

describe(EventSourcingCoreModule, () => {
	it('skips creating default pools when disabled', async () => {
		const eventStore = {
			connect: jest.fn().mockResolvedValue(undefined),
			disconnect: jest.fn().mockResolvedValue(undefined),
			ensureCollection: jest.fn().mockResolvedValue(undefined),
		};
		const snapshotStore = {
			connect: jest.fn().mockResolvedValue(undefined),
			disconnect: jest.fn().mockResolvedValue(undefined),
			ensureCollection: jest.fn().mockResolvedValue(undefined),
		};

		const moduleRef = new EventSourcingCoreModule(
			{ eventStore: { useDefaultPool: false }, snapshotStore: { useDefaultPool: false } } as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			eventStore as any,
			snapshotStore as any,
			{} as any,
		);

		await moduleRef.onModuleInit();

		expect(eventStore.connect).toHaveBeenCalled();
		expect(snapshotStore.connect).toHaveBeenCalled();
		expect(eventStore.ensureCollection).not.toHaveBeenCalled();
		expect(snapshotStore.ensureCollection).not.toHaveBeenCalled();
	});

	it('creates default pools when enabled', async () => {
		const eventStore = {
			connect: jest.fn().mockResolvedValue(undefined),
			disconnect: jest.fn().mockResolvedValue(undefined),
			ensureCollection: jest.fn().mockResolvedValue(undefined),
		};
		const snapshotStore = {
			connect: jest.fn().mockResolvedValue(undefined),
			disconnect: jest.fn().mockResolvedValue(undefined),
			ensureCollection: jest.fn().mockResolvedValue(undefined),
		};

		const moduleRef = new EventSourcingCoreModule(
			{ eventStore: { useDefaultPool: true }, snapshotStore: { useDefaultPool: true } } as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			eventStore as any,
			snapshotStore as any,
			{} as any,
		);

		await moduleRef.onModuleInit();

		expect(eventStore.ensureCollection).toHaveBeenCalled();
		expect(snapshotStore.ensureCollection).toHaveBeenCalled();
	});

	it('logs when disconnect fails', async () => {
		const eventStore = {
			connect: jest.fn().mockResolvedValue(undefined),
			disconnect: jest.fn().mockRejectedValue(new Error('fail-event-store')),
			ensureCollection: jest.fn().mockResolvedValue(undefined),
		};
		const snapshotStore = {
			connect: jest.fn().mockResolvedValue(undefined),
			disconnect: jest.fn().mockResolvedValue(undefined),
			ensureCollection: jest.fn().mockResolvedValue(undefined),
		};

		const moduleRef = new EventSourcingCoreModule(
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			{} as any,
			eventStore as any,
			snapshotStore as any,
			{} as any,
		);

		const loggerSpy = jest.spyOn((moduleRef as any)._logger, 'error');

		await moduleRef.onModuleDestroy();

		expect(loggerSpy).toHaveBeenCalled();
	});
});
