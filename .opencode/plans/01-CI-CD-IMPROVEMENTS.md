# CI/CD Improvements Plan

> Enhanced workflows, multi-version testing matrix, and improved merge controls.

## Overview

This document outlines improvements to the CI/CD pipeline to support:
- Multi-version database testing
- NestJS version matrix testing
- Improved merge queue and required checks
- Performance regression detection in CI
- GitHub-native security scanning and dependency review
- CI concurrency control, least-privilege permissions, and artifact visibility

## Current State

### Existing Workflows
| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci-libraries.yml` | Push/PR to master | Build & test core + integrations |
| `ci-docs.yml` | PR to master | Build & lint docs |
| `ci-other.yml` | PR to master | Catch-all merge check |
| `cd-docs.yml` | Push to master | Deploy docs to GitHub Pages |
| `release.yml` | Push to master | Changesets-based NPM release |
| `benchmark.yml` | Push to master | Run benchmarks (post-merge) |
| `ci-quality-gates.yml` | Push/PR to master | Security scanning and dependency review |
| `benchmark-pr.yml` | PR to master | Benchmark report on PRs |
| `reusable-test-integration.yml` | Called by CI | Shared integration matrix job |

### Current Matrix
- Node.js: 20.x, 22.x
- Databases: Single version each (Postgres 14, MongoDB 8, MariaDB 10.11, DynamoDB local)

## Proposed Changes

### 1. Enhanced Database Version Matrix

**New Docker Compose structure**: Create versioned service definitions.

```yaml
# docker-compose.yml - Updated structure
services:
  # PostgreSQL versions
  postgres-13:
    image: postgres:13
    # ... config
  postgres-14:
    image: postgres:14
    # ... config
  postgres-15:
    image: postgres:15
    # ... config
  postgres-16:
    image: postgres:16
    # ... config
  postgres-17:
    image: postgres:17
    # ... config

  # MongoDB versions
  mongodb-6:
    image: mongo:6
    # ... config
  mongodb-7:
    image: mongo:7
    # ... config
  mongodb-8:
    image: mongo:8
    # ... config

  # MariaDB versions
  mariadb-10:
    image: mariadb:10.11
    # ... config
  mariadb-11:
    image: mariadb:11.4
    # ... config

  # DynamoDB (single version - local emulator)
  dynamodb:
    image: amazon/dynamodb-local:latest
    # ... config
```

**Updated CI Matrix**:

```yaml
strategy:
  matrix:
    node-version: [20.x, 22.x]
    include:
      # PostgreSQL versions
      - database: postgres
        db-version: "13"
      - database: postgres
        db-version: "14"
      - database: postgres
        db-version: "15"
      - database: postgres
        db-version: "16"
      - database: postgres
        db-version: "17"
      # MongoDB versions
      - database: mongodb
        db-version: "6"
      - database: mongodb
        db-version: "7"
      - database: mongodb
        db-version: "8"
      # MariaDB versions
      - database: mariadb
        db-version: "10"
      - database: mariadb
        db-version: "11"
      # DynamoDB (single version)
      - database: dynamodb
        db-version: "latest"
```

### 2. NestJS Version Matrix Testing

Test against multiple NestJS major versions by creating dynamic peer dependency installations:

```yaml
# In ci-libraries.yml
jobs:
  test-nestjs-compat:
    name: NestJS ${{ matrix.nestjs-version }} compatibility
    strategy:
      matrix:
        nestjs-version: ["11.0.0", "11.1.0"]  # Expand as needed
    steps:
      - name: Install NestJS version
        run: |
          pnpm add -D @nestjs/common@${{ matrix.nestjs-version }} \
                     @nestjs/core@${{ matrix.nestjs-version }} \
                     @nestjs/testing@${{ matrix.nestjs-version }} \
                     @nestjs/platform-express@${{ matrix.nestjs-version }}
      - name: Test compatibility
        run: pnpm test
```

**Note**: For NestJS 10 support, a separate peer dependency range would need to be added to each package.json. This is a breaking change consideration.

### 3. Optimized CI Pipeline Structure

**Goal**: Keep CI fast while running comprehensive tests.

```yaml
# Proposed workflow structure
jobs:
  # Stage 1: Quick checks (< 1 min)
  lint-and-typecheck:
    name: Lint & Format
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: ./.github/actions/setup-job-env
      - run: pnpm run ci  # Biome checks

  # Stage 2: Core tests (2-3 min)
  test-core:
    name: Test Core [Node ${{ matrix.node-version }}]
    needs: [lint-and-typecheck]
    strategy:
      matrix:
        node-version: [20.x, 22.x]
    steps:
      - uses: actions/checkout@v6
      - uses: ./.github/actions/setup-job-env
      - run: pnpm test:cov --filter=@ocoda/event-sourcing
      - uses: codecov/codecov-action@v5

  # Stage 3: Integration tests (parallel, 3-5 min each)
  test-integrations:
    name: Test ${{ matrix.database }}-${{ matrix.db-version }} [Node ${{ matrix.node-version }}]
    needs: [test-core]
    strategy:
      fail-fast: false  # Run all combinations
      matrix:
        node-version: [20.x, 22.x]
        include:
          # Full matrix here (see above)
    steps:
      - uses: actions/checkout@v6
      - run: docker compose up -d ${{ matrix.database }}-${{ matrix.db-version }}
      - uses: ./.github/actions/setup-job-env
      - run: pnpm test:cov --filter=@ocoda/event-sourcing-${{ matrix.database }}
      - uses: codecov/codecov-action@v5

  # Stage 4: Quality gates (parallel with integration tests)
  quality-gates:
    name: Quality Gates
    needs: [test-core]
    steps:
      # GitHub CodeQL analysis
      # Dependency review

  # Stage 5: Merge check
  merge-check:
    needs: [lint-and-typecheck, test-core, test-integrations, quality-gates]
    # ...
```

### 4. GitHub Merge Queue

Enable GitHub's merge queue for safer merging:

**Repository Settings**:
- Enable "Require merge queue" in branch protection rules
- Configure queue settings:
  - Merge method: Squash
  - Maximum entries: 10
  - Minimum entries before merge: 1
  - Wait time: 5 minutes

**Benefits**:
- Tests run on merged code (not just PR branch)
- Prevents "merge skew" bugs
- Batches compatible PRs together

### 5. Required Status Checks

Configure comprehensive required checks:

| Check | Required | Description |
|-------|----------|-------------|
| `Lint & Format` | Yes | Fast feedback on code quality |
| `Test Core [Node 20.x]` | Yes | Core library tests |
| `Test Core [Node 22.x]` | Yes | Core library tests (latest) |
| `Test postgres-* [Node 22.x]` | Yes | At least one Postgres version |
| `Test mongodb-* [Node 22.x]` | Yes | At least one MongoDB version |
| `Test mariadb-* [Node 22.x]` | Yes | At least one MariaDB version |
| `Test dynamodb-* [Node 22.x]` | Yes | DynamoDB tests |
| `CodeQL` | Yes | GitHub code scanning |
| `Dependency Review` | Yes | Block on vulnerable dependency changes |
| `Codecov Patch` | Yes | 90% coverage on new code |
| `Codecov Project` | Yes | 90% overall coverage |

### 6. Benchmark Integration in CI

Move benchmarks to PR-level with regression detection:

```yaml
# .github/workflows/benchmark-pr.yml
name: Benchmark PR

on:
  pull_request:
    paths:
      - .github/workflows/benchmark-pr.yml
      - packages/**
      - benchmarks/**

jobs:
  benchmark:
    name: Run Benchmarks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - name: Checkout base branch
        run: git checkout ${{ github.base_ref }} -- benchmarks/report/

      - name: Run benchmarks on PR
        run: pnpm run benchmark <integration>
      - name: Upload report
        run: cat ./benchmarks/report/report.md >> $GITHUB_STEP_SUMMARY
```

### 7. Workflow Reusability

Create reusable workflows for common patterns:

```yaml
# .github/workflows/reusable-test-integration.yml
name: Reusable Integration Test

on:
  workflow_call:
    inputs:
      database:
        required: true
        type: string
      db-version:
        required: true
        type: string
      service:
        required: true
        type: string
      node-version:
        required: true
        type: string

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: docker compose up -d ${{ inputs.service }}
      - uses: ./.github/actions/setup-job-env
        with:
          node-version: ${{ inputs.node-version }}
      - run: pnpm test:cov --filter=@ocoda/event-sourcing-${{ inputs.database }}
      # ... coverage upload
```

## New Workflow Files

| File | Purpose |
|------|---------|
| `.github/workflows/ci-libraries.yml` | Updated with full matrix |
| `.github/workflows/ci-quality-gates.yml` | New: API compat, bundle size, security |
| `.github/workflows/benchmark-pr.yml` | New: PR-level benchmark comparison |
| `.github/workflows/reusable-test-integration.yml` | New: Reusable integration test |
| `.github/dependabot.yml` | New: GitHub-native dependency updates |

## Environment Variables & Secrets

| Secret/Variable | Purpose | Required By |
|-----------------|---------|-------------|
| `CODECOV_TOKEN` | Coverage upload | Existing |
| `NPM_TOKEN` | NPM publishing | Existing |
| `GITHUB_TOKEN` | Releases, read-only PR contexts | Existing (auto) |

## Estimated CI Time

| Job | Estimated Time | Parallelism |
|-----|----------------|-------------|
| Lint & Type Check | 1 min | 1 |
| Test Core | 3 min | 2 (node versions) |
| Test Integrations | 5 min each | ~20 parallel jobs |
| Quality Gates | 3 min | 1 |
| **Total Wall Time** | **~12-15 min** | With parallelism |

## Best-Practice Adjustments

- Add workflow concurrency/cancellation for PR updates
- Use least-privilege `permissions` in all workflows
- Add health checks and explicit wait loops for database services
- Publish benchmark artifacts and CI summaries for visibility
- Use GitHub-native security tooling (CodeQL + dependency review)

## Implementation Checklist

- [ ] Update `docker-compose.yml` with versioned services
- [ ] Update `ci-libraries.yml` with full database matrix
- [ ] Add NestJS version compatibility testing
- [ ] Create `ci-quality-gates.yml` workflow
- [ ] Create `benchmark-pr.yml` workflow
- [ ] Add `.github/dependabot.yml` for GitHub-native dependency updates
- [ ] Configure GitHub merge queue
- [ ] Update branch protection rules
- [ ] Add reusable workflow templates
