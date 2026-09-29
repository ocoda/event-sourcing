// Shared helpers for scripts/check-packages.mjs and scripts/test-consumers.mjs: finds the publishable packages and
// packs them with `pnpm pack`, which rewrites `workspace:` ranges exactly the way `changeset publish` does.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Runs a command, returns its stdout, and throws with the full output when it exits non-zero. */
export function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: 'utf8', ...options });
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n');
		throw new Error(`\`${command} ${args.join(' ')}\` exited with ${result.status}\n${output}`);
	}
	return result.stdout ?? '';
}

/** The non-private packages under packages/, i.e. the ones changesets publishes. */
export function publishablePackages() {
	const integrations = readdirSync(join(repoRoot, 'packages/integration')).map(
		(name) => `packages/integration/${name}`,
	);
	return ['packages/core', ...integrations]
		.filter((dir) => existsSync(join(repoRoot, dir, 'package.json')))
		.map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')) }))
		.filter(({ pkg }) => !pkg.private);
}

/** Packs every publishable package into `destination` and returns the tarball paths. Expects a prior build. */
export function packPackages(destination) {
	return publishablePackages().map(({ dir, pkg }) => {
		if (!existsSync(join(repoRoot, dir, 'dist/index.js'))) {
			throw new Error(`${pkg.name} is not built: ${dir}/dist/index.js is missing. Run \`pnpm build\` first.`);
		}
		run('pnpm', ['pack', '--pack-destination', destination], { cwd: join(repoRoot, dir) });
		const tarball = join(destination, `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`);
		if (!existsSync(tarball)) {
			throw new Error(`pnpm pack did not produce ${tarball}`);
		}
		return { name: pkg.name, version: pkg.version, dir, tarball };
	});
}
