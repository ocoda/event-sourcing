const fs = require('fs');
const { spawn } = require('child_process');

const integration = process.argv[2];
console.log(`Starting ${integration} server...`);

// Read files from the dist directory
const files = fs.readdirSync(`${__dirname}/dist`);
const matchingFile = files.find((file) => file === `${integration}.js`);

// Check if a matching file exists
if (!matchingFile) {
	console.error(`No matching file found for ${integration}.js`);
	process.exit(1);
}

try {
	// Spawn the Node.js process to run the script
	const server = spawn('node', [`${__dirname}/dist/${matchingFile}`], {
		stdio: ['pipe', 'pipe', 'inherit'],
	});

	server.stdout.on('data', (data) => {
		if (data.includes('Server is listening')) {
			const bench = spawn(
				'artillery',
				['run', '--quiet', '--output', `${__dirname}/report/${integration}.json`, 'artillery.yml'],
				{
					stdio: ['inherit', 'inherit', 'inherit'],
				},
			);
			bench.on('exit', (code) => {
				console.log(`Finished ${integration} benchmark with code ${code}`);
				server.kill();
			});
		}
	});

	server.on('exit', (code) => console.log(`Stopped ${integration} server with code ${code}`));
} catch (error) {
	console.error('Error executing the script:', error.message);
	process.exit(1);
}
