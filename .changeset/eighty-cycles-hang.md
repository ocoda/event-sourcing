---
"@ocoda/event-sourcing": minor
"@ocoda/event-sourcing-dynamodb": minor
"@ocoda/event-sourcing-mariadb": minor
"@ocoda/event-sourcing-mongodb": minor
"@ocoda/event-sourcing-postgres": minor
---

# Fixes
Fixes an issue where the metadata from custom event-serializers wasn't returned as an object, resulting in them not being registered by the handlers loader.

# Deprecates
Removes the `disableDefaultSerializer` option from the module, but falls back to the default serializer for each event that doesn't have a custom event-serializer registered. Refactored because the previous behavior left the event-serializer for an event empty, which doesn't make sense.

# Dependencies
Updated various dependencies to their latest versions, including:

- `@aws-sdk/client-dynamodb` & `@aws-sdk/util-dynamodb` to `3.758.0`
- `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`, and `@nestjs/testing` to `11.0.11`
- `@changesets/changelog-github` & `@changesets/cli` to their latest versions
- `@faker-js/faker` to `9.5.1`
- `@swc/core` to `1.11.5`
- `mongodb` to `6.14.0`
- `next` to `15.2.0`
- `pg` to `8.13.3` and `pg-cursor` to `2.12.3`
- `rxjs` to `7.8.2`
- `tsup` to `8.4.0`
- `turbo` to `2.4.4`
- `typescript` to `5.8.2`

These updates include minor fixes, performance improvements, and compatibility enhancements.
