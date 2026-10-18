# Contributing

Use Node.js 22.13 or newer, run `npm ci`, then `npm run check` and `npm test`. Keep changes focused and explain their behavior and validation in your pull request.

Use synthetic fixtures and temporary databases. Do not commit `.env`, runtime databases, real credentials, signed URLs, user files, private screenshots, or local deployment receipts. Run `npm run check-release` after staging changes.

Download changes should preserve exact byte ranges, ETag checks, bounded retries, cancellation, backpressure, and failure of incomplete responses. The default deployment remains publicly accessible; changes to access-control behavior should be explicit.

See `docs/KNOWN_LIMITATIONS.md` for existing engineering work. Do not treat a passing local fixture as production acceptance or an unlimited large-file guarantee.
