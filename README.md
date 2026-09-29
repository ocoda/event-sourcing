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

`@ocoda/event-sourcing` is a powerful library designed to simplify the implementation of advanced architectural patterns in your NestJS application. It provides essential building blocks to help you implement Domain-Driven Design (DDD), CQRS and leverage Event Sourcing to tackle the complexities of modern systems.

> [!NOTE]
> **4.0 is in prerelease** under the npm `next` tag: NestJS 12, ES modules only, Node.js 22.12 or later.
>
> ```bash
> npm install --save-exact @ocoda/event-sourcing@next
> ```
>
> Upgrading from 3.x? Read the [migration guide](docs/src/content/docs/upgrading/v4.mdx). 3.x stays on the `latest` tag and keeps receiving fixes.

## Requirements

| Line           | npm tag  | NestJS | Node.js        | Module format                                                |
| -------------- | -------- | ------ | -------------- | ------------------------------------------------------------ |
| 4.0 prerelease | `next`   | 12     | 22.12 or later | ES modules only; CommonJS apps load them through `require()` |
| 3.x            | `latest` | 11     | 20 or later    | CommonJS                                                     |

See [versioning and support](docs/src/content/docs/upgrading/versioning.mdx) for the tested database versions and the support policy.

## Installation

Install the core. It falls back to in-memory event and snapshot stores, which are fine for tests and prototypes:

```bash
npm install --save-exact @ocoda/event-sourcing@next   # 4.0 prerelease, NestJS 12
npm install @ocoda/event-sourcing@3                   # 3.x, NestJS 11
```

For persistence, add an integration. On 4.x the database driver is a peer dependency, so install it next to the integration:

```bash
# PostgreSQL
npm install --save-exact @ocoda/event-sourcing-postgres@next
npm install pg pg-cursor

# MariaDB
npm install --save-exact @ocoda/event-sourcing-mariadb@next
npm install mariadb

# MongoDB
npm install --save-exact @ocoda/event-sourcing-mongodb@next
npm install mongodb
```

While 4.0 is in prerelease, pin the `@ocoda` packages with `--save-exact`: a caret range such as `^4.0.0-next.0` also matches later prereleases, which can contain breaking changes. TypeScript projects using PostgreSQL also need `@types/pg` and `@types/pg-cursor`.

On 3.x, install the integration with `@3` and leave out the driver, which the integration brings along. The DynamoDB store (`@ocoda/event-sourcing-dynamodb@3`) is only available on 3.x.

## Documentation 📗
Ready to dive right in? Visit [the documentation](https://ocoda.github.io/event-sourcing) to find out how to get started. Until 4.0.0 is released, the site documents 3.x. The 4.0 documentation is in [`docs/`](docs/src/content/docs) on `master`.

## Contact
dries@drieshooghe.com
&nbsp;

## Acknowledgments
This library is inspired by [@nestjs/cqrs](https://github.com/nestjs/cqrs)