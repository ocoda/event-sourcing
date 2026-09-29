// Lints the shape of every publishable package as npm will see it: packs each one and runs publint (warnings fail)
// and @arethetypeswrong/cli on the tarball. attw uses the esm-only profile: the packages ship a single ESM build,
// which CommonJS consumers load through require(esm), so the node10 and node16-cjs resolution modes are not checked.
// It also checks the packed manifests: no `workspace:` range may leak, and the integrations must peer on the core
// version they are released with (`workspace:^` → `^x.y.z`).
// Needs the packages built first; `pnpm check:packages` does that.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packPackages, repoRoot, run } from './pack-packages.mjs';

const bin = (name) => join(repoRoot, 'node_modules', '.bin', name);
const destination = mkdtempSync(join(tmpdir(), 'ocoda-check-packages-'));
const failed = [];

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
