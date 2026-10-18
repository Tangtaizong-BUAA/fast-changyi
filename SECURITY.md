# Security

Report a vulnerability privately through this repository's GitHub Security Advisory page when available. Do not post real credentials, signed URLs, user files, or live exploitation details in public issues. If private reporting is unavailable, contact the repository owner through their public GitHub profile first.

The initial release is a public shared transfer area, with no per-user authentication or authorization. Uploads can incur storage and bandwidth charges. Deploy only to an environment where this access model is intended, and configure ingress restrictions externally if needed. The legacy access-code endpoints do not make public routes private.

Keep `SHARE_SECRET` secret and stable, use scoped RAM permissions, keep the OSS bucket private, and back up both the database and the deployment configuration. Do not use the development secret in production. Automatic retention in OSS is separate from database retention.

Only test your own deployment or explicit synthetic fixtures. See `docs/KNOWN_LIMITATIONS.md` for known upload-lifecycle and concurrency limitations.
