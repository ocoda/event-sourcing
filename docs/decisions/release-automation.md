# Release Automation Decisions

## Context
We implemented the release automation plan to add AI-generated release notes, improved changeset summaries, NPM provenance, and GitHub releases.

## Decisions
- Use a custom Changesets changelog generator to keep summaries consistent and link to GitHub metadata. This keeps release PR content readable without overhauling the existing Changesets workflow.
- Use Anthropic Claude via the official SDK for AI release notes because it offers deterministic models, supports long prompts, and keeps the workflow in Node.js where the rest of the tooling already lives.
- Gate AI generation behind the presence of `ANTHROPIC_API_KEY`, so forks and contributors can run the workflow without secrets while still keeping the release flow functional.
- Use npm provenance via `NPM_CONFIG_PROVENANCE=true` to keep supply-chain metadata attached to published packages without changing the publishing command.
- Publish GitHub Releases via a dedicated composite action so the steps remain reusable and the release workflow stays focused.

## Notes
- Optional integrations (Discord notifications, Snyk, Mergify) are deferred per instruction to keep the initial rollout minimal.
- Release preview comments are implemented to surface version impact early without requiring a separate manual step.
