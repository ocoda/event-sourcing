---
'@ocoda/event-sourcing-mariadb': major
---

The `mariadb` peer dependency now requires `^3.5.3` (was `^3.0.0`). Connector versions below it are affected by three advisories: the cleartext password can leak to a man-in-the-middle despite `ssl: true` (GHSA-cqhc-2h57-wpxf, high), credentials can be sent unprotected (GHSA-42r5-vhpq-m858) and `Buffer` parameters can be escaped unsafely under some multi-byte client character sets (GHSA-g5xc-5w98-jfvm). Upgrade the driver with your package manager, for example `npm install mariadb@^3.5.3`.
