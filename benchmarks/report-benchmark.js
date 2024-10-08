const fs = require('fs');

function calculateDeltas(benchmark, reference) {
	const { req_sec, response_time } = benchmark;
	const refReqSec = reference.req_sec;
	const refResponseTime = reference.response_time;

	return {
		req_sec_delta: ((req_sec - refReqSec) / refReqSec) * 100,
		mean_delta: ((response_time.mean - refResponseTime.mean) / refResponseTime.mean) * 100,
		p50_delta: ((response_time.p50 - refResponseTime.p50) / refResponseTime.p50) * 100,
		p95_delta: ((response_time.p95 - refResponseTime.p95) / refResponseTime.p95) * 100,
		p99_delta: ((response_time.p99 - refResponseTime.p99) / refResponseTime.p99) * 100,
	};
}

function calculateScore(benchmark, reference) {
	const deltas = calculateDeltas(benchmark, reference);

	return deltas.req_sec_delta - (deltas.mean_delta + deltas.p50_delta + deltas.p95_delta + deltas.p99_delta) / 4;
}

function generateMarkdownTable(benchmarks) {
	// Define table headers
	const headers =
		'| Integration | Req/sec | Mean resp. time (ms) | p50 resp. time (ms) | p95 resp. time (ms) | p99 resp. time (ms) |\n';

	// Define separator for table columns
	const separator = '|-------------|---------|-------------------------|----------|----------|----------|\n';

	// Create rows for each benchmark
	const rows = benchmarks
		.map((b) => {
			const { integration, req_sec, response_time, score, deltas } = b;
			const { mean, p50, p95, p99 } = response_time;

			// Format each row of data, including deltas as percentages
			return (
				`| ${integration} | ${req_sec} (${deltas.req_sec_delta.toFixed(2)}%) | ` +
				`${mean.toFixed(2)} | ` +
				`${p50.toFixed(2)} | ` +
				`${p95.toFixed(2)} | ` +
				`${p99.toFixed(2)} |`
			);
		})
		.join('\n');

	// Return the complete markdown table
	return headers + separator + rows;
}

try {
	console.log('Generating report');

	const files = fs.readdirSync(`${__dirname}/report`).filter((file) => file.endsWith('.json'));

	const benchmarks = [];
	for (const file of files) {
		const { aggregate } = JSON.parse(fs.readFileSync(`${__dirname}/report/${file}`, 'utf8'));
		const { rates, summaries } = aggregate;
		const { mean, p50, p95, p99 } = summaries['http.response_time'];

		const benchmark = {
			integration: file.replace('.json', ''),
			req_sec: rates['http.request_rate'],
			response_time: { mean, p50, p95, p99 },
		};

		benchmarks.push(benchmark);
	}

	// Use the in-memory integration as reference for comparison
	const reference = benchmarks.find((b) => b.integration === 'in-memory');

	// Calculate score for each integration
	const results = benchmarks
		.map((b) => ({
			...b,
			deltas: calculateDeltas(b, reference),
			score: calculateScore(b, reference),
		}))
		.sort((a, b) => (a.score < b.score ? 1 : -1));

	fs.writeFileSync(`${__dirname}/report/report.md`, generateMarkdownTable(results));
} catch (error) {
	console.error('Error executing the script:', error.message);
	process.exit(1);
}
