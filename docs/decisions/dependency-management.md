# Dependency Management Decisions

## Context
We implemented the dependency management plan to automate low-risk updates while keeping manual review for higher-risk changes.

## Decisions
- Use Renovate as the primary updater to keep consistent with existing tooling and provide the richest scheduling and grouping options.
- Enable auto-merge for patch and minor updates on stable (non-0.x) packages with minimum release age to reduce churn from hotfixes.
- Require manual review for major and 0.x updates to prevent breaking changes from landing automatically.
- Keep Dependabot configured for alerts only (no PRs) to preserve security notifications without duplicating Renovate work.
- Auto-generate changesets for Renovate PRs so dependency changes are reflected in release automation.

## Notes
- Optional automerge orchestrators (Mergify) are intentionally skipped for now; Renovate handles automerge directly.
- Branch protection and merge queue adjustments are tracked separately in the quality gates/security phase.
