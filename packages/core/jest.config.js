const baseConfig = require('@ocoda/event-sourcing-config/jest/base');

module.exports = {
	...baseConfig,
	moduleNameMapper: {
		'^@ocoda/event-sourcing(|/.*)$': '<rootDir>/lib/$1',
	},
};
