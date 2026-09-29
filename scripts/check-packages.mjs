// Lints the shape of every publishable package as npm will see it: packs each one and runs publint (warnings fail)
// and @arethetypeswrong/cli on the tarball. attw uses the esm-only profile: the packages ship a single ESM build,
// which CommonJS consumers load through require(esm), so the node10 and node16-cjs resolution modes are not checked.
// It also checks the packed manifests: no `workspace:` range may leak, and the integrations must peer on the core
// version they are released with (`workspace:^` → `^x.y.z`). The core's `./testing` subpath is the only one that may
// load vitest, an optional peer: nothing the root entry point imports, directly or through other files, may be part of
// that subpath or import vitest.
// Needs the packages built first; `pnpm check:packages` does that.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { packPackages, repoRoot, run } from './pack-packages.mjs';

const bin = (name) => join(repoRoot, 'node_modules', '.bin', name);
const destination = mkdtempSync(join(tmpdir(), 'ocoda-check-packages-'));
const failed = [];

/** The specifiers of the static, dynamic and side-effect imports and the re-exports in emitted JavaScript. */
const importSpecifiers = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

/**
 * The problems of the files that the root entry point loads: walks its relative imports from `dist/index.js`, and
 * reports every file of the testing subpath it reaches and every import of vitest on the way.
 */
function checkRootEntryPoint(dist) {
	const problems = [];
	const testing = join(dist, 'testing') + sep;
	const seen = new Set();
	const queue = [join(dist, 'index.js')];
	while (queue.length) {
		const file = queue.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		const path = file.slice(dist.length + 1);
		if (file.startsWith(testing)) {
			problems.push(`the root entry point loads dist/${path}, which is part of the testing subpath`);
			continue;
		}
		if (!existsSync(file)) {
			problems.push(`the root entry point loads dist/${path}, which is not packed`);
			continue;
		}
		for (const [, specifier] of readFileSync(file, 'utf8').matchAll(importSpecifiers)) {
			if (specifier.startsWith('.')) {
				queue.push(join(dirname(file), specifier));
			} else if (/^vitest(?:\/|$)/.test(specifier)) {
				problems.push(`the root entry point loads dist/${path}, which imports ${specifier}`);
			}
		}
	}
	// A walk that stops at the entry point proves nothing: the pattern must have found its imports
	if (seen.size < 2) {
		problems.push('found no import in dist/index.js to walk');
	}
	return problems;
}

/**
 * The problems of the core's `./testing` subpath: it must be exported and packed, vitest must be an optional peer, and
 * the root entry point must load without it.
 */
function checkTestingSubpath(tarball, manifest) {
	const problems = [];
	if (manifest.exports?.['./testing']?.import !== './dist/testing/index.js') {
		problems.push('exports has no ./testing entry for dist/testing/index.js');
	}
	if (!manifest.peerDependencies?.vitest || manifest.peerDependenciesMeta?.vitest?.optional !== true) {
		problems.push('vitest is not an optional peer dependency');
	}
	const unpacked = mkdtempSync(join(destination, 'unpacked-'));
	run('tar', ['-xzf', tarball, '-C', unpacked]);
	const dist = join(unpacked, 'package', 'dist');
	if (!existsSync(join(dist, 'testing', 'index.js'))) {
		problems.push('dist/testing/index.js is not packed');
	}
	problems.push(...checkRootEntryPoint(dist));
	return problems;
}

try {
	const packed = packPackages(destination).map((entry) => ({
		...entry,
		manifest: JSON.parse(run('tar', ['-xOzf', entry.tarball, 'package/package.json'])),
	}));
	const core = packed.find(({ name }) => name === '@ocoda/event-sourcing');

	for (const { name, tarball, manifest } of packed) {
		console.log(`\n### ${name}\n`);
		const ranges = ['dependencies', 'peerDependencies', 'optionalDependencies'].flatMap((field) =>
			Object.entries(manifest[field] ?? {}).map(([dependency, range]) => ({ field, dependency, range })),
		);
		for (const { field, dependency, range } of ranges.filter(({ range }) => range.startsWith('workspace:'))) {
			failed.push(`${name} (${field}.${dependency} is still ${range})`);
		}
		const corePeer = manifest.peerDependencies?.['@ocoda/event-sourcing'];
		if (name !== core.name && corePeer !== `^${core.version}`) {
			failed.push(`${name} (peer on @ocoda/event-sourcing is ${corePeer}, expected ^${core.version})`);
		}

		if (name === core.name) {
			failed.push(...checkTestingSubpath(tarball, manifest).map((problem) => `${name} (${problem})`));
		}

		const checks = [
			['publint', ['run', tarball, '--strict']],
			['attw', [tarball, '--profile', 'esm-only', '--format', 'table-flipped']],
		];
		for (const [tool, args] of checks) {
			const { status } = spawnSync(bin(tool), args, { stdio: 'inherit' });
			if (status !== 0) failed.push(`${name} (${tool})`);
		}
	}
} finally {
	rmSync(destination, { recursive: true, force: true });
}

if (failed.length) {
	console.error(`\nPackage checks failed:\n- ${failed.join('\n- ')}`);
	process.exit(1);
}
console.log('\nAll package checks passed.');
