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

`@ocoda/event-sourcing` is a library for [NestJS](https://nestjs.com) with the building blocks for Domain-Driven Design (DDD), CQRS and Event Sourcing:

- **Aggregates and value objects**: aggregates change their state through events, and ids keep their class.
- **Typed command and query buses**: `Command<TResult>` and `Query<TResult>` give `execute()` its result type.
- **An event store** with optimistic concurrency, correlation and causation ids, headers, and a global position per pool that `readAll()` reads in order, for projections and consumers that resume from a checkpoint.
- **Snapshots** that a snapshot repository takes at an interval, so long streams load fast.
- **Event publishers and subscribers**: publishers are awaited, in order per stream, and every delivery failure is reported on an observable.
- **Stores** for PostgreSQL, MariaDB and MongoDB, and in-memory stores for tests, with pools to keep the data of tenants apart. The conformance suites that every store runs are published for your own stores.

> [!NOTE]
> **4.0 is released**: NestJS 12, ES modules only, Node.js 22.12 or later, global positions and `readAll()`, typed buses and awaited publishers.
>
> Upgrading from 3.x? Follow the [migration guide](https://ocoda.github.io/event-sourcing/upgrading/v4). 3.x is on the `latest-3` tag and receives security and critical fixes until at least 2027-03-31.

## Requirements

| Line | npm tag  | NestJS | Node.js        | Module format                                                | Support                                               |
| ---- | -------- | ------ | -------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| 4.x  | `latest` | 12     | 22.12 or later | ES modules only; CommonJS apps load them through `require()` | Supported                                             |
| 3.x  | `latest-3`     | 11     | 20 or later    | CommonJS                                                     | Security and critical fixes until at least 2027-03-31 |

See [versioning and support](https://ocoda.github.io/event-sourcing/upgrading/versioning) for the tested database versions and the support policy.

## Installation

Install the core. It falls back to in-memory event and snapshot stores, which are fine for tests and prototypes:

```bash
npm install @ocoda/event-sourcing@4   # 4.x, NestJS 12
npm install @ocoda/event-sourcing@3   # 3.x, NestJS 11
```

For persistence, add an integration. On 4.x the database driver is a peer dependency, so install it next to the integration:

```bash
# PostgreSQL
npm install @ocoda/event-sourcing-postgres@4 pg pg-cursor

# MariaDB
npm install @ocoda/event-sourcing-mariadb@4 mariadb

# MongoDB
npm install @ocoda/event-sourcing-mongodb@4 mongodb
```

Keep the core and the integrations on the same version. TypeScript projects need TypeScript 5.4 or later, and, with PostgreSQL, `@types/pg` and `@types/pg-cursor`.

On 3.x, install the integration with `@3` and leave out the driver, which the integration brings along. The DynamoDB store (`@ocoda/event-sourcing-dynamodb@3`) is only available on 3.x.

## Documentation 📗

- [The documentation](https://ocoda.github.io/event-sourcing) starts with the [installation](https://ocoda.github.io/event-sourcing/start/install) and the [module configuration](https://ocoda.github.io/event-sourcing/start/module-configuration). The 3.x documentation is at [ocoda.github.io/event-sourcing/v3](https://ocoda.github.io/event-sourcing/v3/).
- [Migrating from 3.x to 4.0](https://ocoda.github.io/event-sourcing/upgrading/v4) lists every breaking change in the order in which you apply them, including the one-time migration of the stored data.
- The [example application](example) is a small NestJS 12 application on PostgreSQL that starts with `docker compose`.
- [Versioning and support](https://ocoda.github.io/event-sourcing/upgrading/versioning) lists the release lines, and [SUPPORT.md](SUPPORT.md) where to ask for help.

## Contact
dries@drieshooghe.com
&nbsp;

## Acknowledgments
This library is inspired by [@nestjs/cqrs](https://github.com/nestjs/cqrs)
