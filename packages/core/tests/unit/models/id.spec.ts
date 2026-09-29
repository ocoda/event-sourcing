import { Id, InvalidIdException } from '@ocoda/event-sourcing';

describe(Id, () => {
	class DeviceId extends Id {
		// A 3.x-style factory of its own keeps compiling and working
		public static generate(): DeviceId {
			return new DeviceId('123-abc');
		}
	}

	class SerialNumber extends Id {}

	it('should generate a DeviceId', () => {
		const generatedDeviceId = DeviceId.generate();
		expect(generatedDeviceId.value).toBe('123-abc');
		expect(generatedDeviceId).toBeInstanceOf(DeviceId);
	});

	it('should create an id of the class it is called on', () => {
		const id = '123-abc';
		const createdDeviceId = DeviceId.from(id);

		expect(createdDeviceId.value).toBe(id);
		expect(createdDeviceId).toBeInstanceOf(DeviceId);
		expect(Id.from(id)).not.toBeInstanceOf(DeviceId);
		expectTypeOf(createdDeviceId).toEqualTypeOf<DeviceId>();
		expectTypeOf(Id.from(id)).toEqualTypeOf<Id>();
	});

	it('should tell ids of different classes apart, even with the same value', () => {
		expect(DeviceId.from('123-abc').equals(DeviceId.from('123-abc'))).toBe(true);
		expect(DeviceId.from('123-abc').equals(SerialNumber.from('123-abc'))).toBe(false);
		expect(Id.from('123-abc').equals(DeviceId.from('123-abc'))).toBe(false);
	});

	it('should throw when trying to create an id from an undefined variable', () => {
		const id = undefined as unknown as string;
		// idType names the id class the value was given to
		expect(() => DeviceId.from(id)).toThrow(new InvalidIdException({ value: id, idType: 'DeviceId' }));
		expect(() => Id.from('')).toThrow(new InvalidIdException({ value: '', idType: 'Id' }));
	});

	it('should keep the class when from() is called detached', () => {
		expect(() => [''].map(DeviceId.from)).toThrow(new InvalidIdException({ value: '', idType: 'DeviceId' }));

		const [deviceId] = ['123-abc'].map(DeviceId.from);
		expect(deviceId.value).toBe('123-abc');
		expect(deviceId).toBeInstanceOf(DeviceId);
		expect(deviceId.equals(DeviceId.from('123-abc'))).toBe(true);
		expect(['123-abc'].map(Id.from)[0]).not.toBeInstanceOf(DeviceId);
	});

	it('should hand out one bound factory per class', () => {
		expect(DeviceId.from).toBe(DeviceId.from);
		expect(DeviceId.from).not.toBe(SerialNumber.from);
		expect(DeviceId.from.name).toBe('from');
	});

	it('should let a subclass replace a factory', () => {
		class LegacyId extends Id {
			public static override from(id: string): LegacyId {
				return new LegacyId(id.toUpperCase());
			}
		}
		class AssignedId extends Id {}
		const from = (id: string) => Id.from(id);
		AssignedId.from = from;

		expect(LegacyId.from('abc').value).toBe('ABC');
		expect(['abc'].map(LegacyId.from)[0].value).toBe('ABC');
		expect(AssignedId.from).toBe(from);
		expect(Id.from).not.toBe(from);
		expect(SerialNumber.from('abc')).toBeInstanceOf(SerialNumber);
	});

	it('can be spied on', () => {
		const from = vi.spyOn(SerialNumber, 'from');

		SerialNumber.from('abc');

		expect(from).toHaveBeenCalledWith('abc');
	});
});
