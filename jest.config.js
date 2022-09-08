module.exports = {
	moduleFileExtensions: ["js", "json", "ts"],
	rootDir: "lib",
	testRegex: ".*\\.spec\\.ts$",
	transform: {
	  "^.+\\.(t|j)s$": [
		"@swc/jest",
		{
			"jsc": {
			  "parser": {
				"syntax": "typescript",
				"decorators": true
			  },
			  "transform": {
				"legacyDecorator": true,
				"decoratorMetadata": true
			  },
			  "target": "es2016",
			  "keepClassNames": true
			},
			"minify": false,
		  }
	],
	},
	collectCoverageFrom: ["**/*.(t|j)s"],
	coverageDirectory: "../coverage",
	testEnvironment: "node",
  };