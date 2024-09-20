import type { IEventMapTarget } from '../../event-map';

export class UnregisteredEventException extends Error {
	constructor(target: IEventMapTarget) {
		let name: string;

		switch (typeof target) {
			case 'string': {
				name = target;
				break;
			}
			case 'object': {
				name = target.constructor.name;
				break;
			}
			case 'function': {
				name = target.name;
				break;
			}
		}

		super(`Event '${name}' is not registered. Register it in the EventSourcingModule.`);
	}
}
