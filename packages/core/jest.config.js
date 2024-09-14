module.exports = {
	moduleFileExtensions: ['js', 'json', 'ts'],
    testPathIgnorePatterns: ['/tests/unit/integration/'], // TODO: re-enable when the integrations are moved out of the core package
	rootDir: '.',
	testRegex: '.*\\.spec\\.ts$',
	transform: {
		'^.+\\.(t|j)s$': [
			'@swc/jest',
			{
				jsc: {
					parser: {
						syntax: 'typescript',
						decorators: true,
					},
					transform: {
						legacyDecorator: true,
						decoratorMetadata: true,
					},
					target: 'es2016',
					keepClassNames: true,
				},
				minify: false,
			},
		],
	},
	collectCoverageFrom: ['lib/**/*.(t|j)s'],
	coverageDirectory: './coverage',
	testEnvironment: 'node',
	moduleNameMapper: {
		'^@ocoda/event-sourcing(|/.*)$': '<rootDir>/lib/$1',
	},
};
