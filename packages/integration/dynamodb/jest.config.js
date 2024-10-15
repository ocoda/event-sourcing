const baseConfig = require('@ocoda/event-sourcing-config/jest/base');

module.exports = {
	...baseConfig,
	moduleNameMapper: {
		'^@ocoda/event-sourcing(|/.*)$': '<rootDir>/../../core/lib/$1',
		'^@ocoda/event-sourcing-dynamodb(|/.*)$': '<rootDir>/lib/$1',
	},
};
