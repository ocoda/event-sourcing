# Security policy

## Supported versions

| Version       | npm dist-tag | Status                              | Fixes                                                                                                                  |
| ------------- | ------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 4.x           | `next`       | Prerelease                          | Fixes land on `master` and ship in the next `4.0.0-next.N`. No stability or support guarantee until 4.0.0 is released. |
| 3.x           | `latest`     | Supported until at least 2027-03-31 | Security and critical bug fixes, released as 3.x patch versions from the `3.x` branch.                                 |
| 2.x and older | none         | Not supported                       | None. Upgrade to 3.x or 4.x.                                                                                           |

This covers `@ocoda/event-sourcing`, `@ocoda/event-sourcing-postgres`, `@ocoda/event-sourcing-mariadb`, `@ocoda/event-sourcing-mongodb` and, on 3.x only, `@ocoda/event-sourcing-dynamodb`. The end of 3.x support will be announced here and in the [versioning and support](docs/src/content/docs/upgrading/versioning.mdx) docs before it happens.

## Reporting a vulnerability

Report it privately. Never open a public issue, pull request or discussion about a vulnerability.

- **Preferred:** [open a private security advisory](https://github.com/ocoda/event-sourcing/security/advisories/new) on GitHub.
- **Fallback:** if you can't use GitHub, email `dries@drieshooghe.com`.

A vulnerability in a dependency, such as NestJS or a database driver, belongs with that project, unless the way these packages use it causes the problem.

## What to include

- the affected packages and versions
- your NestJS, Node.js and database versions
- the kind of vulnerability and its impact: what an attacker can do, and what access they need first
- steps to reproduce or a proof of concept, as small as possible
- a suggested fix, if you have one

## What happens next

One volunteer maintains this project, so handling is best-effort and there is no guaranteed response time.

1. The report is acknowledged once it has been read.
2. It is assessed: whether it affects these packages, which versions, and how severe it is. Follow-up questions go through the advisory.
3. A fix is prepared privately and released on each supported line that it affects: as a 3.x patch release, and on 4.x in the next 4.x release.

## Disclosure

Once the fix is released, the GitHub Security Advisory is published with the affected and patched versions, and a CVE is requested when it applies. Reporters are credited in the advisory unless they ask not to be. Please keep the details private until then.
