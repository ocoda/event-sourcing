const fs = require("node:fs");

const databases = ["in-memory", "postgres", "mongodb", "mariadb", "dynamodb"];
const regressionThreshold = 1.5;

let hasRegression = false;
let report = "## Performance Benchmark Results\n\n";

for (const database of databases) {
	const currentPath = `benchmarks/report/${database}.json`;
	const baselinePath = `benchmarks/baseline/${database}.json`;

	if (!fs.existsSync(currentPath)) {
		report += `### ${database}\n\nNo current benchmark report found.\n\n`;
		continue;
	}

	const current = JSON.parse(fs.readFileSync(currentPath, "utf8"));
	const hasBaseline = fs.existsSync(baselinePath);

	report += `### ${database}\n\n`;

	if (!hasBaseline) {
		report += "No baseline available for comparison.\n\n";
		continue;
	}

	const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

	report += "| Operation | Baseline | Current | Change |\n";
	report += "|-----------|----------|---------|--------|\n";

	for (const [operation, currentValue] of Object.entries(current)) {
		const baselineValue = baseline[operation] ?? currentValue;
		const ratio = currentValue / baselineValue;
		const change = ((ratio - 1) * 100).toFixed(1);
		const marker = ratio > regressionThreshold ? "regression" : ratio < 0.8 ? "improvement" : "stable";

		if (ratio > regressionThreshold) {
			hasRegression = true;
		}

		report += `| ${operation} | ${baselineValue}ms | ${currentValue}ms | ${marker} ${change}% |\n`;
	}

	report += "\n";
}

if (hasRegression) {
	report += "\nPerformance regression detected: one or more operations are >50% slower.\n";
}

fs.mkdirSync("benchmarks/report", { recursive: true });
fs.writeFileSync("benchmarks/report/comparison.md", report);
fs.writeFileSync("/tmp/compare-output", `regression=${hasRegression}`);

console.log(report);
process.exit(hasRegression ? 1 : 0);
