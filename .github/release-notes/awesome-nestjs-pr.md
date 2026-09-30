<!--
DRAFT, not opened. A pull request to https://github.com/nestjs/awesome-nestjs that updates the existing entry of
@ocoda/event-sourcing (README.md, "EventStore" section), whose description still mentions DynamoDB, which 4.0 dropped.
Open it (maintainer, from a fork) once 4.0.0 is on npm `latest` and the docs are deployed, then delete this file.

Branch: update-ocoda-event-sourcing
Commit and PR title: Update @ocoda/event-sourcing for 4.0

The change, one line in README.md:

- - ![](https://img.shields.io/github/stars/ocoda/event-sourcing.svg?style=flat-square) [`@ocoda/event-sourcing`](https://github.com/ocoda/event-sourcing) - An Event Sourcing and CQRS module for NestJS with support for MongoDB and DynamoDB.
+ - ![](https://img.shields.io/github/stars/ocoda/event-sourcing.svg?style=flat-square) [`@ocoda/event-sourcing`](https://github.com/ocoda/event-sourcing) - Event Sourcing, CQRS and DDD building blocks with typed command and query buses, snapshots, and event stores for PostgreSQL, MariaDB and MongoDB that read all events in order.

The PR body below follows the repository's pull request template.
-->

# Pull Request

## Type of Change

- [ ] Adding a new resource
- [x] Updating an existing resource
- [ ] Removing an outdated resource
- [ ] Fixing a bug (broken link, typo, etc.)
- [ ] Other (please describe)

## Description

Updates the description of `@ocoda/event-sourcing` under **Components & Libraries > EventStore**. The current text says it supports MongoDB and DynamoDB; version 4.0 (for NestJS 12) supports PostgreSQL, MariaDB and MongoDB and no longer ships a DynamoDB store. The new description follows the entry format of CONTRIBUTING.md: one sentence, capital letter, no leading "An", ends with a period.

## Checklist

Please ensure your PR meets the following requirements:

- [x] I have read the [contribution guidelines](../CONTRIBUTING.md)
- [x] The resource I'm adding has **at least 10 GitHub stars** (if applicable)
- [x] The link I'm adding is working and points to the correct resource
- [x] I have placed the resource in the appropriate category
- [x] The description is clear and concise
- [x] I have followed the existing format:
  - `- [Name](URL) - Description.`
  - For libraries with star badges: `- ![](star-badge-url) [Name](URL) - Description.`

## Resource Details (if adding a new resource)

- **Name:** `@ocoda/event-sourcing` (existing entry)
- **URL:** https://github.com/ocoda/event-sourcing
- **Category:** Components & Libraries > EventStore (unchanged)
- **GitHub Stars (if applicable):** 270 (September 2026)
- **Why is this resource valuable to the NestJS community?** It brings Event Sourcing to NestJS applications with the building blocks around it: aggregates and value objects, typed command and query buses, snapshots, awaited event publishers, and stores for PostgreSQL, MariaDB and MongoDB that give every event a global position, so projections can read all events in order and resume from a checkpoint. Documentation: https://ocoda.github.io/event-sourcing
