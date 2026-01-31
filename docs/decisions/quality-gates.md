# Quality Gates Decisions

## Context
We implemented quality gates to detect API breaking changes, guard bundle size, track performance regressions, and enforce license compliance.

## Decisions
- Use API Extractor across all packages to generate API reports and detect breaking changes, aligning with TypeScript ecosystem best practices.
- Store API reports in `api-reports/` to create a stable diff baseline that can be reviewed in PRs.
- Use `size-limit` with the small library preset to track bundle size growth per package and comment on PRs.
- Compare benchmarks against the base branch report and fail on >50% regressions to keep performance regressions visible early.
- Add license compliance checks to CI to prevent accidental inclusion of incompatible licenses.
- Add OpenSSF Scorecard workflow for supply-chain visibility without adding optional external integrations (Snyk deferred).

## Notes
- Benchmark comparisons reuse existing reports from the base branch, keeping runtime costs predictable.
- API breaking changes require an explicit override label to proceed.
