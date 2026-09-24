# @deepseek-ai/dsh-platform-user-console

English | [中文](README.zh.md)

Web Console provider for [`@deepseek-ai/dsh-platform-user`](../platform-user/README.md). It registers into `ctx.platformUsers`, verifies Supabase Auth JWTs locally via JWKS, and reads the caller's governance record from the Web Console backend (`GET /api/users/me`) using the user's own bearer token.

## Plugin contract

- `inject = ['platformUsers']`
- `Config`
  - `supabaseUrl` — Supabase project URL; only its Auth issuer is used for JWT verification
  - `webConsoleBaseUrl` — Web Console backend base URL, default `http://127.0.0.1:8080`
- `apply(ctx, config)` — resolves config, creates the JWKS key store, and registers the provider

The provider assumes the Web Console `GET /api/users/me` endpoint returns the `ApiResponse` envelope (`{ success, data, error }`) whose `data` is the camelCase governance record (`id`, `authSubject`, `loginName`, `displayName`, `email`, `status`, `platformRoles`, `createdAt`, and the optional approval/disable/lock trail fields). Unknown fields such as `orgUnits` are ignored.

## Invariants

No runtime invariant: the provider is a thin transport adapter that verifies JWTs locally and reads one backend endpoint per request, with no durable relation to check.

## Model Experience

No direct model-facing effect. This provider is a backend identity adapter for enterprise user governance.

## Known Limitations and Deferred Work

- **Pending users read as `pending_approval`** — the seam value keeps the backend status; consumers decide whether a pending user may proceed.
