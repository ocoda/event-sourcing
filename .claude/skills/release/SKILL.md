---
name: release
description: Maintainer preflight for cutting an @ocoda/event-sourcing release. Checks CI, changesets, pre mode, the version PR, smoke and upgrade runs, and npm provenance and dist-tags afterwards. Never publishes.
disable-model-invocation: true
argument-hint: "[master | 3.x]"
allowed-tools: Bash(git fetch -q origin) Bash(gh run list *) Bash(gh run view *) Bash(gh pr list *) Bash(gh pr view *) Bash(gh pr diff *) Bash(gh release list *) Bash(npm view *) Bash(pnpm exec changeset status --verbose)
---

# Release preflight

Work through the checklist top to bottom for the release line in $ARGUMENTS (default `master`). Mark each item **green** (with evidence), **red**, or **n/a**. At the first red, stop and report. The maintainer decides what happens next.

## Ground rules

- **Publishing happens only in CI.** `.github/workflows/release.yml` publishes through npm trusted publishing (OIDC, with provenance). Local publish commands are denied in `.claude/settings.json`. Even when a CI publish fails, the fix is to re-run the workflow, never to publish from a laptop.
- **GitHub changes need the maintainer's yes.** Opening the version PR, re-running workflows and merging change GitHub state. Each one needs the maintainer's explicit "yes" for that specific action, in this session.
- **Keep `release.yml` as it is.** npm's trusted publishers are bound to that exact filename and the `npm` environment of its `Publish` job.

## Checklist

1. **Line and workflow.**
   - Run `git fetch -q origin`, then `git show origin/<line>:.github/workflows/release.yml`. Its `on.push.branches` must include `<line>`.
   - Check that `git show origin/<line>:.changeset/config.json` has `baseBranch` equal to `<line>`.
   - For `3.x` once 4.x is `latest`: the publish command must pass a non-latest dist-tag such as `--tag v3`. Without it, a 3.x patch moves `latest` back. That is red.

2. **CI is green on the release head.**
   - Run `gh run list --workflow ci.yml --branch <line> --limit 1 --json headSha,status,conclusion`.
   - Green requires `conclusion` to be `success` and `headSha` to equal `git rev-parse origin/<line>`.

3. **Changesets are present and sane.**
   - List them with `git ls-tree --name-only origin/<line> .changeset/`. Ignore `README.md` and `config.json`. No changesets means nothing to release: n/a, stop.
   - From a clean checkout of `origin/<line>`, run `pnpm exec changeset status --verbose` and record the packages and their computed versions.
   - **`3.x`:** every release must be `patch`, and every new version must start with `3.`.
   - **`master`:** every new version must start with `4.` or higher. A `3.x` version computed on master is red unless the maintainer confirms it: it would publish v4-line code as a 3.x release, and the `3.x` branch needs those version numbers. A computed major must be intended. A major computed from a `minor` changeset is the changesets-2.x amplification with `workspace:*` peers: confirm it with the maintainer.
   - Read every changeset: it must be user-facing text (see the `changeset` skill). This check must print nothing:

     ```sh
     grep -n '[$]`' .changeset/*.md
     ```

4. **Pre mode.** Check for `.changeset/pre.json` on `origin/<line>`:
   - **After 4.0.0 (master today):** expect no `pre.json`. Versions are stable 4.x and publish under `latest`.
   - **v4 prerelease (before 4.0.0):** expect `"mode": "pre"` with tag `next`. Versions look like `4.0.0-next.N` and publish under the `next` dist-tag.
   - **4.0.0 GA:** pre mode must already be exited (`changeset pre exit`, merged by PR) before the version PR.
   - **No `pre.json` and a computed major on master:** this publishes 4.0.0 as `latest`. It is red unless the maintainer confirms GA.

5. **Version PR.**
   - After the push to `<line>`, release.yml's `Version` job runs changesets/action. Check it with `gh run list --workflow release.yml --branch <line> --limit 1`.
   - Expect a PR from `changeset-release/<line>` titled `[ci] release`, or `[ci] release (next)` in pre mode. Find it with `gh pr list --head changeset-release/<line> --json number,state,headRefOid`.
   - **The run log says Actions may not create pull requests, but `git ls-remote origin changeset-release/<line>` shows the branch.** Open the PR by hand, after the maintainer says yes: `gh pr create --base <line> --head changeset-release/<line> --title "[ci] release" --body "Version packages (opened manually: Actions cannot create PRs in this repo)."`
   - **A PR created with `GITHUB_TOKEN` doesn't trigger `ci.yml`.** If `ci-ok` never reports on it, ask the maintainer to close and reopen the PR, or push to its branch.
   - **Review the diff (`gh pr diff <n>`).** All five `package.json` versions must be equal (fixed group). CHANGELOG entries must match the changesets. Consumed changeset files must be deleted. No unexpected major.

6. **Smoke and upgrade checks** on the version PR head. Work in the scratchpad or a temporary directory, never inside the repo.
   - **Build and pack.** Use a separate worktree of `origin/changeset-release/<line>`. Run `pnpm install --frozen-lockfile` and `pnpm build --filter="./packages/**"`. Then run `pnpm --dir <pkg-dir> pack --pack-destination <tmp>/tarballs` for `packages/core` and each `packages/integration/*`. pnpm 10's `pack` doesn't take `--filter`. Packing rewrites the `workspace:*` peer to the new exact version.
   - **Smoke.** Create a fresh app outside the repo. Install the five tarballs plus the peers (`@nestjs/common`, `@nestjs/core`, `reflect-metadata`, `rxjs`, at the peer ranges), and a TypeScript that matches the repo. The app must:
     - import only from the package roots;
     - boot `EventSourcingModule.forRoot` with the in-memory stores, then with the postgres and mongodb stores against the docker-compose services;
     - append events, read the stream back, save and load a snapshot, and exit 0.
   - **Upgrade.** In the same app:
     - install the currently published version of the line (`npm view @ocoda/event-sourcing dist-tags --json --prefer-online`);
     - write events and a snapshot to a fresh pool in each database;
     - switch to the tarballs and read the data back: same events and versions, the snapshot loads, and a stale-version append still throws `EventStoreVersionConflictException`.

     Data written by the previous version that the new one can't read is red, unless a changeset documents the migration.

7. **Merge.** The maintainer merges. Present the PR number, head SHA, versions and target dist-tag. If the maintainer asks you to merge, first confirm that the head SHA hasn't changed since the checks.

8. **Publish run.** Run `gh run list --workflow release.yml --branch <line> --limit 1`, then `gh run view <id> --log-failed` if it failed. Report a failure. Re-running it is the maintainer's call.
   - Status `waiting` means the `Publish` job waits for its `npm` deployment. The maintainer approves it on the run page (**Review deployments**). Give them the run URL; the approval is theirs.

9. **Verify on npm.** Use `--prefer-online` so the local cache can't answer. For each of the five packages:
   - `npm view <pkg>@<version> version _npmUser.name dist.attestations.provenance.predicateType peerDependencies --json --prefer-online`. The publisher must be `GitHub Actions`, and the provenance `https://slsa.dev/provenance/v1`.
   - `npm view <pkg> dist-tags --json --prefer-online`. The intended tag (`latest`, `next`, or the 3.x maintenance tag) must point at `<version>`, and no other tag may have moved.
   - `gh release list --limit 10`. The tags and releases for `<version>` must exist.

## Report

```
## Release preflight: <line> → <version(s)>
| # | Item | Status | Evidence |
Next action for the maintainer: <one line>
```

Done when every item is green or n/a with evidence, or the report stops at the first red and names it.
