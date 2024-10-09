import { Id, InvalidIdException } from '@ocoda/event-sourcing';

describe(Id, () => {
	class DeviceId extends Id {
		public static generate(): DeviceId {
			return new DeviceId('123-abc');
		}
	}

	it('should generate a DeviceId', () => {
		const generatedDeviceId = DeviceId.generate();
		expect(generatedDeviceId.value).toBeDefined();
	});

	it('should create a DeviceId from an existing id', () => {
		const id = '123-abc';
		const createdDeviceId = DeviceId.from(id);
		expect(createdDeviceId.value).toBe(id);
	});

	it('should throw when trying to create an id from an undefined variable', () => {
		let id: string;
		expect(() => DeviceId.from(id)).toThrow(InvalidIdException.becauseEmpty());
	});
});
