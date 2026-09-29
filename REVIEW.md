# REVIEW.md

This file calibrates code review (human, `/code-review`, or a review bot) for this repo. Rank findings by what a library user would feel after upgrading.

## Blocker

- **Data correctness.** The patch can lose, overwrite, duplicate or reorder events or snapshots. Watch for:
  - broken optimistic concurrency
  - partial appends
  - swallowed read errors that return truncated history
- **Stuck resources.** A store can hang or leak connections, cursors or transactions, including on early `break` and on thrown errors.
- **Breaking upgrades.** A public API change or a change in persisted format lands on `3.x`, or on `master` without a changeset and migration note. A change breaks existing deployments on upgrade: schema/DDL, indexes, IAM permissions, or config.
- **Published output.** The package shape changes unintentionally: exports, `.d.ts` types, decorator metadata, class names used in logs and messages, or peer ranges.
- **Workflows.** A change to `.github/workflows/**` widens permissions, feeds untrusted input into `run:`, or touches `release.yml` without maintainer sign-off.

## Important

- Tests that can't fail. Look for un-awaited `rejects` and `resolves` assertions, tautologies, and assertions on the wrong store or pool.
- Missing coverage of the failure path next to the happy path.
- Error mapping that leaks driver-specific errors instead of the core exceptions.
- Missing or inaccurate changesets.

## Nit

- Naming and comments. Report these only when they would mislead a reader.

## Skip

- `pnpm-lock.yaml`, generated `CHANGELOG.md` entries, commits listed in `.git-blame-ignore-revs`, and `docs/public/**` build output.
- Formatting and lint style: `oxfmt` and `oxlint` gate these in CI.
