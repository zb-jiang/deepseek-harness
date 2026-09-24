# Agent Note: Platform Users on Local PostgreSQL

Status: implemented

English | [中文](2026-09-21-platform-users-local-pg.zh.md)

## Problem

All governance metadata lived in the Supabase Postgres instance behind an international network path. DNS resolution failures and latency spikes there stalled the Web Console backend: JDBC calls blocked on socket reads, the Hikari pool saturated, and every browser request timed out at the 30s axios limit while the backend logged nothing. The employee-side provider compounded the exposure by reading `platform_users` directly from Supabase PostgREST under an RLS self-read policy.

## Decision

The enterprise deployment moves all database storage to a locally operated PostgreSQL instance and shrinks Supabase to two services: Auth (JWT issuance, verified locally via JWKS by every component) and Storage (knowledge-base files).

- The `SUPABASE_DB_HOST`/`SUPABASE_DB_USER`/`SUPABASE_DB_PASSWORD` variable names are unchanged; their values now point at the local instance. The Web Console backend and the Flowable engine read them unchanged.
- The Supabase `auth.users` registration trigger for `platform_users` no longer exists. The Web Console's `JwtAuthConverter` now inserts a `pending_approval` row at JWT verification time when no record exists (JIT registration). It requires the JWT `email` claim, takes `login_name`/`display_name` from `user_metadata` with email and email local-part fallbacks (the trigger's COALESCE branches), and lets `gen_random_uuid()` mint the id. Missing email claims keep the degraded no-principal path.
- The employee-side provider `@deepseek-ai/dsh-platform-user-supabase` is deleted. Its replacement, `@deepseek-ai/dsh-platform-user-console`, verifies the JWT locally via JWKS and reads the caller's record from the Web Console backend (`GET /api/users/me`) with the user's bearer token. The provider swap is the only bundle-patch change; `ctx.platformUsers` consumers are untouched.
- Browser sign-in (supabase-js through `platform-user-api` with the anon key) and knowledge-base Storage passthrough stay on Supabase. The Storage policy for `kb-*` buckets is relaxed to "authenticated read/write per bucket prefix": the original policy referenced governance tables that now live in the local database and cannot exist in Supabase. Per-user visibility is enforced by the Web Console backend's metadata layer; every Storage call goes through that backend, so direct-to-Storage access by a signed-in user is the only widened surface, accepted as a trade-off.

## Alternatives considered

**Keep Supabase storage and harden clients with fast-fail JDBC settings.** The timeouts were treated, but the shared international path remains a recurring failure source and every query pays the remote RTT.

**Let the employee side read the local database directly.** That would distribute DB credentials to every employee PC and reintroduce per-client connection management for a single-row read already served by the Web Console.

**Supabase Auth webhook to provision records.** It needs a public ingress and secret hosting for parity with what JIT gets for free at an existing verification point.

## Consequences

Platform list pages and process operations no longer depend on the international network path; list queries return in local-latency time.

System administration now spans two runbooks: the trimmed Supabase setup guide (project, Auth, Storage) and a local PostgreSQL setup guide (install, schema, variables, one-time `platform_users` migration).

JIT registration only covers sign-ins that carry an email claim; anonymous or phone-only auth users degrade exactly as before (no record, no roles).
