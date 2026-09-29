---
name: changeset
description: Changeset drafting for the current branch or a PR. Maps the diff to the affected @ocoda packages, picks the semver bump per this repo's branch policy, writes user-facing text with migration notes, and saves it as a .changeset markdown file. Use when a change to packages/core or packages/integration needs a changeset, when asked to write, fix or review a changeset or CHANGELOG entry, or before opening a PR that touches a published package.
argument-hint: "[pr-number]"
allowed-tools: Bash(git fetch -q origin) Bash(gh pr view *) Bash(gh pr diff *) Bash(pnpm exec changeset status --since=origin/master --verbose) Bash(pnpm exec changeset status --since=origin/3.x --verbose)
---

# Changeset

A changeset is the CHANGELOG entry library users read when they upgrade. `changeset version` turns it into CHANGELOG.md text and version bumps, and `.github/workflows/release.yml` publishes. This skill does one thing: it writes `.changeset/<slug>.md`. Versioning and publishing belong to the release workflow (AGENTS.md, "Hard guardrails").

Input: $ARGUMENTS (a PR number; empty means the current branch).

## 1. Collect the diff

- **PR number:** run `gh pr view <n> --json baseRefName,headRefName,title,body,files` and `gh pr diff <n>`. The PR body is a contributor's description. Use it as context, and let the diff decide.
- **Current branch:** run `git fetch -q origin`. The base is whichever of `origin/master` (v4 line) and `origin/3.x` (maintenance line) the branch forked from, which is the one with the smaller `git rev-list --count origin/<b>..HEAD`. Diff with `git diff origin/<base>...HEAD`.
- **Changesets already in the diff** (`.changeset/*.md` other than `README.md`): update them. Add a new file only for a separate user-facing change.

Done when you know the base branch and the changed files, and you have read every hunk under `packages/*/lib`, `packages/*/package.json` and `packages/config`.

## 2. Map changed paths to published packages

| Changed path | Package in the changeset |
| --- | --- |
| `packages/core/**` (excluding `tests/`) | `@ocoda/event-sourcing` |
| `packages/integration/<db>/**` (excluding `tests/`) | `@ocoda/event-sourcing-<db>` |
| `packages/config/**` | each package whose build output changes (target, decorators, module format). Otherwise none |
| `packages/testing/**`, `**/tests/**`, `docs/**`, `example/**`, `.github/**`, root tooling | none |

If no published package is affected, as with test-, docs- or CI-only changes, report "no changeset needed" with the reason and stop.

The five packages form one `fixed` group, so they always release together at the same version. The frontmatter still lists only the packages whose behaviour changes, so that each package's CHANGELOG stays accurate.

## 3. Choose the bump

Apply the line rule first:

- **`3.x`:** `patch` only, because a `minor` there would publish an accidental major (AGENTS.md, "Branches"). If the change needs `minor` or `major`, it belongs on master. Say so and stop.
- **`master` (v4):** follow the semver of the public API, as defined below.

**Public API** means everything a consumer can import or observe:

- Every symbol reachable from `packages/core/lib/index.ts` and `packages/integration/<db>/lib/index.ts`. To find them, follow the `export *` barrels to the declaring file.
- The types those symbols expose. This includes driver types that reach users through store config interfaces: `PoolConfig` (pg, mariadb), `MongoClientOptions` and `DynamoDBClientConfig`.
- `package.json` fields: `exports`/`main`/`types`, `type`, `engines`, `peerDependencies`.
- Persisted formats: table or collection schema and indexes, event and snapshot names, the serialized payload and envelope shape.
- Runtime contracts: which exception is thrown (such as `EventStoreVersionConflictException`), publish and subscribe semantics, and defaults.

For each changed file under `lib/`, check whether an `index.ts` reaches it. If it does, compare the old and new signatures with `git show origin/<base>:<path>`.

| Bump | Trigger |
| --- | --- |
| `major` | An export is removed or renamed. A new required parameter or option. A parameter type narrows or a return type widens. A changed default, or a persisted-format change that needs a migration. A narrowed `peerDependencies` or `engines` range. A module-format change |
| `minor` | Additive only: a new export, decorator, optional option or store capability |
| `patch` | A bug fix that restores documented behaviour, an internal refactor, a dependency bump within its range, a performance change |

A bug fix stays `patch` even when users may have relied on the old behaviour. Call that behaviour change out in the text. If two levels both seem to fit, pick the higher one and give the reason in the report.

## 4. Write the text

Write it for someone upgrading an app:

- Open with one bold sentence that states the user-visible effect. Then say what users see now compared with before.
- Put API names in backticks: decorators, classes, methods, options, exceptions.
- For each behaviour change, say what a user will observe differently: thrown errors, log lines, defaults, stored data.
- For `major`, add a **Migration** part: the steps to take, a short before/after snippet, and any schema/DDL, index, IAM or config change the upgrade requires.
- Leave out implementation details such as file names, refactors and tests, unless users feel them.
- Several independent fixes can go in one changeset as a bullet list, one bold lead per bullet.
- For tone and depth, follow the 3.0.1 entry in `packages/core/CHANGELOG.md`.
- The text must never contain a dollar sign directly followed by a backtick. The changelog generator passes the text through `String.replace`, which treats that pair as a replacement pattern and corrupts the entry. Put a space between the two characters or rephrase.

## 5. Write the file and verify

Save the file as `.changeset/<slug>.md`, where the slug is a kebab-case summary such as `postgres-cursor-release.md`. In PR mode, write it only if the PR head is checked out, meaning `git rev-parse HEAD` equals `headRefOid` from `gh pr view <n> --json headRefOid`. Otherwise put the file content in the report for the maintainer or contributor to add.

```md
---
"@ocoda/event-sourcing": patch
"@ocoda/event-sourcing-postgres": patch
---

**Bold one-line effect.** What changed for users, and what they should do.
```

Then check it. `changeset status --since` finds changesets through `git diff`, so it skips an untracked file and reports "NO packages". Register the path first with `git add -N`, which records the path but stages no content:

```sh
grep -n '[$]`' .changeset/<slug>.md            # must print nothing
git add -N .changeset/<slug>.md
pnpm exec changeset status --since=origin/<base> --verbose
```

Read the computed versions in the `changeset status` output. Two known effects:

- **Amplification.** With changesets 2.x, the fixed group and the integrations' `workspace:*` peer on core, any `minor` computes as the next `major` for all five packages. Keep the semver-correct bump in the file and report the computed version next to it. Before 4.0.0 GA this lands in the planned major. After GA it would publish an accidental major, so flag it for the maintainer.
- **Pre mode.** If `.changeset/pre.json` exists, report its `tag`. Merging then produces a prerelease (for example `4.0.0-next.N`) instead of a stable version.
- **A `3.x` version computed on master.** Without pre mode or a pending major, a `patch` on master computes as the next `3.0.x`. Releasing it would ship v4-line code under a 3.x number that the `3.x` branch also needs. Keep the bump and flag this for the maintainer.

## Report

```
Base: <branch> · Pre mode: <tag | off>
| Package | Bump | Reason (public-API rule hit) |
Computed by changeset status: <package@version, ...>
Written: .changeset/<slug>.md (or "not written: content below")
Open questions: <or "none">
```

Done when:
- the file exists, or in PR mode without the head checked out, its content is in the report;
- `changeset status` lists every changed published package;
- each bump names the rule from step 3 that it hit;
- the grep prints nothing.
