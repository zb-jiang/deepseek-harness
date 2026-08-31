# @deepseek-ai/dsh-platform-user-supabase

English | [中文](README.zh.md)

Supabase-backed provider for [`@deepseek-ai/dsh-platform-user`](../platform-user/README.md). It registers into `ctx.platformUsers`, stores one governance row per external auth subject in a configurable Postgres table, validates every row that crosses the storage boundary, and maps those rows to the seam's stable `PlatformUser` value.

## Plugin contract

- `inject = ['platformUsers']`
- `Config`
  - `url` — Supabase project URL
  - `serviceRoleKey` — server-side service-role key
  - `usersTable` — governance table name, default `platform_users`
- `apply(ctx, config)` — resolves config, creates one Supabase client, and registers the provider

The provider assumes the table exposes these columns:

- `id`
- `auth_subject`
- `login_name`
- `display_name`
- `email`
- `status`
- `platform_roles`
- `created_at`
- `created_by`
- `approved_at`
- `approved_by`
- `disabled_at`
- `disabled_by`
- `disabled_reason`
- `locked_at`
- `locked_by`
- `locked_reason`

## Model Experience

No direct model-facing effect. This provider is a backend persistence adapter for enterprise user governance.

## Known Limitations and Deferred Work

- **No migration package yet** — this package assumes the target Supabase table already exists with the expected columns and compatible types.
- **List filtering is provider-local** — `list({ statuses?, role? })` currently reads rows then filters in the provider, which is correct for the seam but not yet tuned for large tenant sizes.
