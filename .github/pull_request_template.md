## What

<!-- What this pull request changes. Link the issue it fixes, e.g. "Fixes #123". -->

## Why

<!-- The problem or use case behind the change, and any context a reviewer needs. -->

## How tested

<!-- The tests you added or ran, and against which databases and versions, so a reviewer can reproduce them. -->

## Checklist

- [ ] The pull request targets the right branch: `master` for v4, `3.x` for 3.x fixes
- [ ] Tests added or updated, and `pnpm test` passes locally
- [ ] Changeset added with `pnpm exec changeset`, or not needed (nothing under `packages/*` changed), or the `no-changeset` label requested
- [ ] Docs updated in `docs/`, or not needed
- [ ] Breaking change called out above with a migration note, or there is none
