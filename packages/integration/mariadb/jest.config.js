module.exports = {
	moduleFileExtensions: ['js', 'json', 'ts'],
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
		'^@ocoda/event-sourcing(|/.*)$': '<rootDir>/../../core/lib/$1',
		'^@ocoda/event-sourcing-mariadb(|/.*)$': '<rootDir>/lib/$1',
	},
};
