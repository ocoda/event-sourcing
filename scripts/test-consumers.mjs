// Consumer smoke test for the published packages. Packs every publishable package, installs the tarballs (not
// workspace links) into two throwaway NestJS 12 applications outside the workspace, compiles
// fixtures/consumers/main.ts into each and runs it:
//   - esm: "type": "module", loads the packages with import.
//   - cjs: "type": "commonjs", tsc emits require() calls, so Node loads the ESM-only packages through require(esm).
// The application uses the in-memory stores, so no database is needed, but it imports every integration package
// together with its driver to prove they load. Needs the packages built first; `pnpm test:consumers` does that.
// Set KEEP_CONSUMERS=1 to keep the generated applications for debugging.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packPackages, repoRoot, run } from './pack-packages.mjs';

const fixture = join(repoRoot, 'fixtures', 'consumers');
const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');

/** The version the workspace has installed, so the consumers resolve from the pnpm store instead of the registry. */
const installed = (from, name) =>
	JSON.parse(readFileSync(join(repoRoot, from, 'node_modules', name, 'package.json'), 'utf8')).version;

const pinned = (from, names) => Object.fromEntries(names.map((name) => [name, installed(from, name)]));

const work = mkdtempSync(join(tmpdir(), 'ocoda-consumers-'));
let failed = false;

try {
	const tarballDir = join(work, 'tarballs');
	mkdirSync(tarballDir);
	const tarballs = packPackages(tarballDir);

	const dependencies = {
		...Object.fromEntries(tarballs.map(({ name, tarball }) => [name, `file:${tarball}`])),
		...pinned('packages/core', ['@nestjs/common', '@nestjs/core', 'class-transformer', 'reflect-metadata', 'rxjs']),
		...pinned('packages/integration/mariadb', ['mariadb']),
		...pinned('packages/integration/mongodb', ['mongodb']),
		...pinned('packages/integration/postgres', ['pg', 'pg-cursor']),
	};
	const devDependencies = {
		...pinned('.', ['@types/node']),
		...pinned('packages/integration/postgres', ['@types/pg', '@types/pg-cursor']),
	};

	for (const [variant, type] of [
		['esm', 'module'],
		['cjs', 'commonjs'],
	]) {
		const dir = join(work, variant);
		mkdirSync(join(dir, 'src'), { recursive: true });
		cpSync(join(fixture, 'main.ts'), join(dir, 'src', 'main.ts'));
		cpSync(join(fixture, 'tsconfig.json'), join(dir, 'tsconfig.json'));
		const manifest = {
			name: `ocoda-consumer-${variant}`,
			private: true,
			type,
			// Install with the workspace's pnpm, whose store already holds every pinned version.
			packageManager: rootManifest.packageManager,
			dependencies,
			devDependencies,
		};
		writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

		console.log(`\n### ${variant}: install, compile, run`);
		// Every peer is listed explicitly: nothing may be auto-installed from the registry, and an unmet peer range fails
		// the install. That covers the drivers and the integrations' peer on core, which pnpm checks against the
		// version inside the core tarball (pnpm >= 12.7.0). The settings go through the environment: pnpm 12 ignores
		// `--config.auto-install-peers` and other dotted `--config.*` flags (pnpm/pnpm#16276).
		run('pnpm', ['install', '--ignore-workspace', '--prefer-offline'], {
			cwd: dir,
			env: { ...process.env, pnpm_config_auto_install_peers: 'false', pnpm_config_strict_peer_dependencies: 'true' },
		});
		run(process.execPath, [tsc, '-p', dir]);

		const emitted = readFileSync(join(dir, 'dist', 'main.js'), 'utf8');
		for (const specifier of ['@ocoda/event-sourcing', '@ocoda/event-sourcing/class-transformer']) {
			const quoted = `["']${specifier.replaceAll('/', '\\/')}["']`;
			const loads = new RegExp(variant === 'cjs' ? `require\\(${quoted}\\)` : `from ${quoted}`).test(emitted);
			if (!loads) {
				throw new Error(`${variant}: the compiled application does not load ${specifier} the ${variant} way`);
			}
		}

		const app = spawnSync(process.execPath, ['--enable-source-maps', join('dist', 'main.js')], {
			cwd: dir,
			encoding: 'utf8',
			timeout: 60_000,
		});
		process.stdout.write(app.stdout);
		process.stderr.write(app.stderr);
		if (app.status !== 0 || !app.stdout.includes(`CONSUMER OK (${variant})`)) {
			console.error(`${variant}: the consumer application failed (exit ${app.status ?? app.signal})`);
			failed = true;
		}
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	failed = true;
} finally {
	if (process.env.KEEP_CONSUMERS) {
		console.log(`\nKept the consumer applications in ${work}`);
	} else {
		rmSync(work, { recursive: true, force: true });
	}
}

if (failed) process.exit(1);
console.log('\nBoth consumer applications passed.');
