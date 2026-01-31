# Dependency Management Decisions

## Context
We implemented the dependency management plan to automate low-risk updates while keeping manual review for higher-risk changes.

## Decisions
- Use Dependabot as the sole updater, matching the earlier consolidation decision to remove Renovate tooling.
- Keep Dependabot update PRs disabled (alerts only) until we validate branch protections and auto-merge policies.
- Require manual review for any dependency update PRs until the updated automation rules are finalized.
- Auto-generate changesets for Dependabot PRs so dependency changes remain reflected in release automation.

## Notes
- Optional automerge orchestrators (Mergify) are intentionally skipped for now.
- Branch protection and merge queue adjustments are tracked separately in the quality gates/security phase.
