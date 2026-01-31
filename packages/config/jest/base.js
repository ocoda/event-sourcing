module.exports = {
	moduleFileExtensions: ['js', 'json', 'ts'],
	rootDir: '.',
	testRegex: '.*\\.spec\\.ts$',
	collectCoverageFrom: [
		'lib/**/*.ts',
		'!lib/**/*.d.ts',
		'!lib/**/index.ts',
		'!lib/**/*.interface.ts',
		'!lib/**/*.type.ts',
		'!lib/**/*.enum.ts',
		'!lib/**/*.constants.ts',
	],
	coverageThreshold: {
		global: {
			branches: 85,
			functions: 90,
			lines: 90,
			statements: 90,
		},
	},
	coverageReporters: ['text', 'lcov', 'json-summary'],
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
	testEnvironment: 'node',
};
