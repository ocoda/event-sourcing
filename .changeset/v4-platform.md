---
'@ocoda/event-sourcing': major
'@ocoda/event-sourcing-dynamodb': major
'@ocoda/event-sourcing-mariadb': major
'@ocoda/event-sourcing-mongodb': major
'@ocoda/event-sourcing-postgres': major
---

Move to NestJS 12 and publish the packages as ES modules only.

**Breaking changes**

- **NestJS 12 only.** The core peers on `@nestjs/common` and `@nestjs/core` `^12.0.0` and on `rxjs` `^7.8.0`. NestJS 11 applications stay on 3.x, which keeps receiving fixes.
- **ESM-only.** Every package ships one ES module build (`"type": "module"`), and its `exports` map points `import`, `require` and `default` at the same file. ESM applications import the packages as before. CommonJS applications, including TypeScript compiled to CommonJS, keep using `require()`: Node.js 22.12 and later load ES modules through `require()` natively. Because there is no second CommonJS build, Nest never sees two copies of a class such as `EventStore`.
- **Node.js 22.12 or later** is required (`engines.node` is `>=22.12`).
- **The database drivers are peer dependencies.** The integrations no longer install their driver, so install it next to the integration, in the version you choose:
  - `@ocoda/event-sourcing-postgres`: `pg` (`^8.15.0`, the first release with an ES module entry) and `pg-cursor` (`^2.14.0`). TypeScript projects also need `@types/pg` and `@types/pg-cursor`.
  - `@ocoda/event-sourcing-mongodb`: `mongodb` (`^6.10.0 || ^7.0.0`).
  - `@ocoda/event-sourcing-mariadb`: `mariadb` (`^3.0.0`).
  - `@ocoda/event-sourcing-dynamodb`: `@aws-sdk/client-dynamodb` and `@aws-sdk/util-dynamodb` (`^3.582.0`, the first release whose `CreateTableCommandInput` has `OnDemandThroughput`).
- The integrations now peer on `@nestjs/common` `^12.0.0` and on `@ocoda/event-sourcing` with a caret range (`^4.0.0`) instead of an exact version. They no longer list `@nestjs/core`, `rxjs` or `reflect-metadata`, which they do not import.
- **The root entry shims are gone.** The `index.js`, `index.d.ts` and `index.ts` files next to each `package.json` were removed, and `exports` exposes only the package root and `package.json`. Import from the package name (`@ocoda/event-sourcing`, `@ocoda/event-sourcing-postgres`, ...); paths into the package, such as `@ocoda/event-sourcing/dist/...`, no longer resolve.

The stored event and snapshot formats are unchanged, so no data migration is needed.

**Migrating from 3.x**

1. Upgrade the application to NestJS 12 and Node.js 22.12 or later.
2. Install the driver of every integration you use, for example `npm install pg pg-cursor` for PostgreSQL or `npm install mongodb` for MongoDB.
3. Replace any import of a path inside the packages with an import from the package name.
4. CommonJS applications need no code changes. A test runner with its own module loader, such as Jest, loads these packages with the same setup it needs for NestJS 12, which is ESM-only as well.
