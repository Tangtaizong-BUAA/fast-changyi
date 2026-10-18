# Changelog

## 0.1.0 — 2026-10-18

Initial public release as `fast-changyi`.

- Publish the complete application source, browser UI, download engines, tests, deployment examples, design specifications, and sanitized engineering history.
- Preserve the v3 download changes: fixed same-origin native downloads, fresh upstream grants, resumable streaming, Range/ETag/length checks, bounded retries, cancellation, and backpressure.
- Preserve permanent-file UI handling and public access without an access code.
- Add reproducible browser SDK preparation, an environment template, production configuration checks, README, MIT license, third-party notices, and CI.
- Update the transitive `qs` dependency to 6.16.1, make test cleanup tolerate an already-exited server, and keep UI retry timers alive until each test finishes on Node.js 22 and newer.
- Replace original production bucket/account/host defaults and exclude runtime databases, real credentials, temporary acceptance files, unrelated downloaded material, and private screenshots.

The public release is prepared independently from the original deployed service; it does not publish or redeploy that service's private configuration. See `docs/KNOWN_LIMITATIONS.md` for the current acceptance boundary and upload lifecycle issues.
