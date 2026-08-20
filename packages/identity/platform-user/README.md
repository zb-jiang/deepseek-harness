# @deepseek-ai/dsh-platform-user

English | [中文](README.zh.md)

Platform-user governance Service Definition (`ctx.platformUsers`). This seam stores the Harness-side governance record layered on top of an external identity backend such as Supabase Auth: registration into `pending_approval`, platform-role assignment, lookup by auth subject, administrative disable/lock, and restore back to `active`.

## Service API

- `registerProvider(provider)` — mounts the one active provider. Duplicate providers fail loud with `PlatformUserError` code `DUPLICATE_PROVIDER`.
- `registerPendingUser(request)` — creates a pending governance record after the external auth backend has created the subject.
- `getById(id)` / `getByAuthSubject(authSubject)` — read one record.
- `list({ statuses?, role? })` — lists matching records.
- `approve(id, { approvedBy, platformRoles })` — approves only a `pending_approval` user and writes its initial role set.
- `setRoles(id, { changedBy, platformRoles })` — replaces the full platform-role set of an existing user.
- `disable(id, { disabledBy, reason? })` / `lock(id, { lockedBy, reason? })` — administrative state changes.
- `restore(id, { restoredBy })` — returns a `disabled` or `locked` user to `active`.

The seam validates role names, rejects duplicate roles, and rejects invalid status transitions before the provider is called.

## Model Experience

No direct model-facing effect. Consumers such as an API gateway or Web management UI decide what human-visible or model-visible surfaces expose platform-user governance.

## Known Limitations and Deferred Work

- **No auth session seam yet** — this package governs Harness-side user records only; login, token refresh, password reset, and SSO handshakes stay in the external identity backend and future consumer packages.
- **No built-in audit stream yet** — the seam returns updated records directly; a later consumer or companion package should publish durable governance audit events.
