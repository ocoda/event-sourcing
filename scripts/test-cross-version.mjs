// Cross-version test: the published 3.0.2 packages write a corpus, this repository's driver reads it back.
//
//   pnpm test:cross-version --database <postgres|mariadb|mongodb>
//
// 1. Installs fixtures/cross-version/v3 from its committed lockfile (npm ci) into a temporary copy, outside the pnpm
//    workspace.
// 2. Per target (MongoDB: the standalone server, and the replica set when ES_TEST_MONGODB_RS_URL is set; CI requires
//    it), in a namespace of its own (a PostgreSQL schema, a MariaDB database or a MongoDB database):
//    a. writer.mjs writes the corpus with 3.0.2 in TZ=America/New_York and records what 3.0.2 read back (manifest);
//    b. the driver's cross-version specs (tests/cross-version, vitest.cross-version.mts) read it with this repository's
//       code, with XV_MANIFEST, XV_NAMESPACE, XV_MONGODB_URL, XV_TOPOLOGY and TZ set;
//    c. append-after.mjs appends with 3.0.2 once more, and must succeed or fail as the driver's
//       tests/cross-version/cross-version.json says ("fails" once the driver migrates to schema v2);
//    d. the namespace is dropped, unless KEEP_XV=1.
//
// Connection settings: the ES_TEST_* variables of packages/testing/unit/db.ts, with the same defaults.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const repoRoot = join(import.meta.dirname, '..');
const fixture = join(repoRoot, 'fixtures', 'cross-version', 'v3');
const DATABASES = ['postgres', 'mariadb', 'mongodb'];
/** The time zone of the 3.0.2 writer (WRITER_TIME_ZONE in fixtures/cross-version/v3/corpus.mjs; writer.mjs checks it). */
const WRITER_TIME_ZONE = 'America/New_York';
/** The exit codes of append-after.mjs per expectation. */
const APPEND_AFTER_EXIT_CODES = { succeeds: 0, fails: 2 };

const { values } = parseArgs({ options: { database: { type: 'string' } } });
const database = values.database === 'pg' ? 'postgres' : values.database;
if (!DATABASES.includes(database)) {
	console.error(`Usage: node scripts/test-cross-version.mjs --database <${DATABASES.join('|')}>`);
	process.exit(2);
}

/** Runs a command with inherited output and returns its exit code. */
const run = (command, args, options = {}) => {
	console.log(`\n$ ${[command, ...args].join(' ')}`);
	const result = spawnSync(command, args, { stdio: 'inherit', ...options });
	if (result.error) throw result.error;
	return result.status ?? 1;
};

const runOrThrow = (command, args, options) => {
	const status = run(command, args, options);
	if (status !== 0) throw new Error(`\`${command} ${args.join(' ')}\` exited with ${status}`);
};

/** A MongoDB URL whose database (path) is the namespace, keeping the host and the options. */
const namespacedMongoUrl = (url, namespace) => {
	const parsed = new URL(url);
	parsed.pathname = `/${namespace}`;
	return parsed.toString();
};

const targets = () => {
	if (database !== 'mongodb') return [{ name: database }];
	const list = [{ name: 'standalone', url: process.env.ES_TEST_MONGODB_URL || 'mongodb://localhost:27017' }];
	if (process.env.ES_TEST_MONGODB_RS_URL) {
		list.push({ name: 'replica-set', url: process.env.ES_TEST_MONGODB_RS_URL });
	} else if (process.env.CI && process.env.CI !== 'false') {
		throw new Error('ES_TEST_MONGODB_RS_URL must be set in CI: the cross-version test runs on both MongoDB topologies');
	}
	return list;
};

const packageDir = join(repoRoot, 'packages', 'integration', database);
const { appendAfter } = JSON.parse(
	readFileSync(join(packageDir, 'tests', 'cross-version', 'cross-version.json'), 'utf8'),
);
if (!(appendAfter in APPEND_AFTER_EXIT_CODES)) {
	throw new Error(`cross-version.json: appendAfter must be one of ${Object.keys(APPEND_AFTER_EXIT_CODES)}`);
}

const work = mkdtempSync(join(tmpdir(), 'ocoda-cross-version-'));
const failures = [];
try {
	const writer = join(work, 'v3');
	cpSync(fixture, writer, { recursive: true, filter: (source) => !source.includes('node_modules') });
	runOrThrow('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: writer });

	for (const target of targets()) {
		const namespace = `xv_${randomBytes(4).toString('hex')}`;
		const url = target.url && namespacedMongoUrl(target.url, namespace);
		const connection = ['--database', database, '--namespace', namespace, ...(url ? ['--url', url] : [])];
		const manifest = join(work, `${target.name}.manifest.json`);
		const label = `${database} (${target.name}, ${namespace})`;
		console.log(`\n### ${label}`);

		runOrThrow(process.execPath, ['namespace.mjs', 'create', ...connection], { cwd: writer });
		try {
			const env = { ...process.env, TZ: WRITER_TIME_ZONE };
			if (run(process.execPath, ['writer.mjs', ...connection, '--out', manifest], { cwd: writer, env }) !== 0) {
				failures.push(`${label}: the 3.0.2 writer failed`);
				continue;
			}

			const specs = run(
				'pnpm',
				[
					'--filter',
					`@ocoda/event-sourcing-${database}`,
					'exec',
					'vitest',
					'run',
					'--config',
					'vitest.cross-version.mts',
				],
				{
					cwd: repoRoot,
					env: {
						...env,
						XV_MANIFEST: manifest,
						XV_NAMESPACE: namespace,
						XV_TOPOLOGY: target.name,
						...(url ? { XV_MONGODB_URL: url } : {}),
					},
				},
			);
			if (specs !== 0) failures.push(`${label}: the cross-version specs failed`);

			const expected = APPEND_AFTER_EXIT_CODES[appendAfter];
			const status = run(process.execPath, ['append-after.mjs', ...connection, '--manifest', manifest], {
				cwd: writer,
			});
			if (status !== expected) {
				failures.push(
					`${label}: a 3.0.2 append afterwards ${appendAfter === 'fails' ? 'must fail (exit 2)' : 'must succeed (exit 0)'}, append-after.mjs exited with ${status}`,
				);
			}
		} finally {
			if (process.env.KEEP_XV) {
				console.log(`Kept the namespace ${namespace} (KEEP_XV)`);
			} else {
				run(process.execPath, ['namespace.mjs', 'drop', ...connection], { cwd: writer });
			}
		}
	}
} catch (error) {
	failures.push(error instanceof Error ? error.message : String(error));
} finally {
	if (process.env.KEEP_XV) {
		console.log(`\nKept the writer and the manifests in ${work} (KEEP_XV)`);
	} else {
		rmSync(work, { recursive: true, force: true });
	}
}

if (failures.length > 0) {
	console.error(`\nCross-version test failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
	process.exit(1);
}
console.log(`\nCross-version test passed: ${database} reads what 3.0.2 wrote.`);
