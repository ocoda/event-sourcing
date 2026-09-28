<p align="center">
  <a href="http://ocoda.io/" target="blank"><img src="https://github.com/ocoda/.github/raw/master/assets/ocoda_logo_full_gradient.svg" width="600" alt="Ocoda Logo" /></a>
</p>

<p align="center">
  <a href="https://github.com/ocoda/event-sourcing/actions/workflows/ci-libraries.yml">
    <img src="https://github.com/ocoda/event-sourcing/actions/workflows/ci-libraries.yml/badge.svg">
  </a>
  <a href="https://codecov.io/gh/ocoda/event-sourcing">
    <img src="https://codecov.io/gh/ocoda/event-sourcing/branch/master/graph/badge.svg?token=D6BRXUY0J8">
  </a>
  <a href="https://github.com/ocoda/event-sourcing/blob/master/LICENSE.md">
    <img src="https://img.shields.io/badge/License-MIT-green.svg">
  </a>
</p>
<p align="center">
    <a href="https://github.com/ocoda/event-sourcing/issues/new?labels=bug&template=bug_report.md">Report a bug</a>
    &nbsp;|&nbsp;
    <a href="https://github.com/ocoda/event-sourcing/issues/new?labels=enhancement&template=feature_request.md">Request a feature</a>
</p>

## About this library

This is a complementing module for `@ocoda/event-sourcing`, a powerful library designed to simplify the implementation of advanced architectural patterns in your [**NestJS**](https://nestjs.com/) application. It provides essential building blocks to help you implement Domain-Driven Design (DDD), CQRS and leverage Event Sourcing to tackle the complexities of modern systems.

This store-driver library uses [DynamoDB](https://aws.amazon.com/dynamodb/) as an underlying driver for event- and snapshot-stores, and needs to be installed together with the core module `@ocoda/event-sourcing` in order to get started.

## Documentation 📗
Ready to dive right in? Visit [the documentation](https://ocoda.github.io/event-sourcing) to find out how to get started.

## DynamoDB specifics
- The events of a single `appendEvents` call are written in one `TransactWriteItems` transaction, so they are stored all-or-nothing and never overwrite an existing version. DynamoDB limits a transaction to **100 items and 4 MB** (and every item to 400 KB), so at most 100 events can be appended per call; larger appends are rejected before anything is written. Snapshots are appended transactionally as well. Transactional writes consume twice the write capacity of regular writes.
- Reads of a single stream (and the version checks before an append) are strongly consistent, which consumes twice the read capacity of eventually consistent reads. Queries on the global secondary indexes (all events, latest snapshots of an aggregate) are eventually consistent.
- `Date` values in event and snapshot payloads are stored as ISO-8601 strings, like the SQL stores do.
- `ensureCollection(pool, config)` creates tables with `BillingMode: PAY_PER_REQUEST` by default. With `BillingMode: PROVISIONED`, the given `ProvisionedThroughput` (default: 1 read and 1 write capacity unit) is applied to the table and to its global secondary index. It waits until a new table is `ACTIVE`.

## Contact
dries@drieshooghe.com
&nbsp;

## Acknowledgments
This library is inspired by [@nestjs/cqrs](https://github.com/nestjs/cqrs)