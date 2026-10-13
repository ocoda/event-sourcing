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

This is a store integration for `@ocoda/event-sourcing`, a library for [**NestJS**](https://nestjs.com/) with the building blocks for Domain-Driven Design (DDD), CQRS and Event Sourcing.

It provides the `MariaDBEventStore` and `MariaDBSnapshotStore`, on InnoDB: they keep events and snapshots in [MariaDB](https://mariadb.com/) or [MySQL](https://www.mysql.com/), with a global position per pool for `readAll()`. It is tested on MariaDB 10.11, 11.4, 11.8 and 12.3 and the newest rolling release, and, from 4.1, on MySQL 8.4 and 9.7 and the newest Innovation release: see [supported versions](https://ocoda.github.io/event-sourcing/integrations/mariadb#versions). The same classes serve both servers.

On MySQL, logging in over TCP with `caching_sha2_password` needs TLS, `cachingRsaPublicKey` or `allowPublicKeyRetrieval`: see [Connecting to MySQL](https://ocoda.github.io/event-sourcing/integrations/mariadb#mysql-auth). On a Galera cluster, a multi-primary Group Replication group, TiDB or Vitess, the event store reports `globalOrder: 'best-effort'`: see [Topologies and capabilities](https://ocoda.github.io/event-sourcing/integrations/mariadb#capabilities).

## Installation
The `mariadb` driver (`^3.5.3`) is a peer dependency, so install it next to the core module:
```bash
npm install @ocoda/event-sourcing @ocoda/event-sourcing-mariadb mariadb
```

Requires Node.js 22.12 or later and NestJS 12. The package is ESM-only; CommonJS applications load it through `require()`, which Node.js supports for ES modules since 22.12. Keep it on the same version as `@ocoda/event-sourcing`.

## Upgrading from 3.x
4.0 stores events and snapshots in a new schema (schema v2), and refuses a 3.x event table until it is migrated. Migrate it once, offline, with `migrate()`, after a dry run. `migrate()` runs on MariaDB only. See the [runbook](https://ocoda.github.io/event-sourcing/integrations/mariadb#runbook) and [Migrating from 3.x to 4.0](https://ocoda.github.io/event-sourcing/upgrading/v4).

## Documentation 📗
- [MariaDB and MySQL](https://ocoda.github.io/event-sourcing/integrations/mariadb): the supported versions, the configuration, MySQL's authentication, the topologies, the schema, the privileges and the migration from 3.x.
- [The documentation](https://ocoda.github.io/event-sourcing) starts with the [installation](https://ocoda.github.io/event-sourcing/start/install). The 3.x documentation is at [ocoda.github.io/event-sourcing/v3](https://ocoda.github.io/event-sourcing/v3/).
- [Versioning and support](https://ocoda.github.io/event-sourcing/upgrading/versioning) and the [changelog](https://github.com/ocoda/event-sourcing/blob/master/packages/integration/mariadb/CHANGELOG.md).

## Contact
dries@drieshooghe.com
&nbsp;

## Acknowledgments
This library is inspired by [@nestjs/cqrs](https://github.com/nestjs/cqrs)
