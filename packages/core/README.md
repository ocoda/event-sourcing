<p align="center">
  <a href="http://ocoda.io/" target="blank"><img src="https://github.com/ocoda/.github/raw/master/assets/ocoda_logo_full_gradient.svg" width="600" alt="Ocoda Logo" /></a>
</p>

<p align="center">
  <a href="https://github.com/ocoda/event-sourcing/actions/workflows/ci.yml?query=branch%3Amaster">
    <img src="https://github.com/ocoda/event-sourcing/actions/workflows/ci.yml/badge.svg?branch=master">
  </a>
  <a href="https://codecov.io/gh/ocoda/event-sourcing">
    <img src="https://codecov.io/gh/ocoda/event-sourcing/branch/master/graph/badge.svg?token=D6BRXUY0J8">
  </a>
  <a href="https://github.com/ocoda/event-sourcing/blob/master/LICENSE.md">
    <img src="https://img.shields.io/badge/License-MIT-green.svg">
  </a>
</p>
<p align="center">
    <a href="https://github.com/ocoda/event-sourcing/issues/new?template=bug_report.yml">Report a bug</a>
    &nbsp;|&nbsp;
    <a href="https://github.com/ocoda/event-sourcing/issues/new?template=feature_request.yml">Request a feature</a>
</p>

## About this library

This is the core module of `@ocoda/event-sourcing`, a library for [**NestJS**](https://nestjs.com/) with the building blocks for Domain-Driven Design (DDD), CQRS and Event Sourcing: aggregates, value objects, typed command and query buses, an event store with global positions and `readAll()`, snapshots, and event publishers and subscribers.

It keeps events and snapshots in memory by default, which is fine for tests and prototypes. For persistence, add a store integration:
- [`@ocoda/event-sourcing-postgres`](https://www.npmjs.com/package/@ocoda/event-sourcing-postgres)
- [`@ocoda/event-sourcing-mariadb`](https://www.npmjs.com/package/@ocoda/event-sourcing-mariadb)
- [`@ocoda/event-sourcing-mongodb`](https://www.npmjs.com/package/@ocoda/event-sourcing-mongodb)

## Installation
```bash
npm install @ocoda/event-sourcing
```

Requires Node.js 22.12 or later, NestJS 12 and, in TypeScript projects, TypeScript 5.4 or later. The package is ESM-only; CommonJS applications load it through `require()`, which Node.js supports for ES modules since 22.12.

Two entry points need an optional peer dependency:
- `@ocoda/event-sourcing/class-transformer`: `ClassTransformerEventSerializer`, for events with class-transformer decorators (`class-transformer@^0.5.1`).
- `@ocoda/event-sourcing/testing`: the conformance suites for your own event and snapshot stores (`vitest` 4 or 5).

## Documentation 📗
- [The documentation](https://ocoda.github.io/event-sourcing) starts with the [installation](https://ocoda.github.io/event-sourcing/start/install).
- Upgrading from 3.x? Follow [Migrating from 3.x to 4.0](https://ocoda.github.io/event-sourcing/upgrading/v4). The 3.x documentation is at [ocoda.github.io/event-sourcing/v3](https://ocoda.github.io/event-sourcing/v3/).
- [Versioning and support](https://ocoda.github.io/event-sourcing/upgrading/versioning) and the [changelog](https://github.com/ocoda/event-sourcing/blob/master/packages/core/CHANGELOG.md).

## Contact
dries@drieshooghe.com
&nbsp;

## Acknowledgments
This library is inspired by [@nestjs/cqrs](https://github.com/nestjs/cqrs)
