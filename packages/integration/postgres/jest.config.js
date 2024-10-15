const baseConfig = require('@ocoda/event-sourcing-config/jest/base');

module.exports = {
	...baseConfig,
	moduleNameMapper: {
		'^@ocoda/event-sourcing(|/.*)$': '<rootDir>/../../core/lib/$1',
		'^@ocoda/event-sourcing-postgres(|/.*)$': '<rootDir>/lib/$1',
	},
};
