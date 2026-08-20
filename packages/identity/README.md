# identity/ — shared identity

English | [中文](README.zh.md)

Identity and governance values shared across product domains. Some packages hold anonymous or external-auth correlation ids; others define the Harness-side governance record layered on top of an external identity backend.

| Package | Role | ctx key |
|---|---|---|
| [`anonymous-user-id/`](anonymous-user-id/README.md) | Persists one anonymous Harness-home correlation id for telemetry, feedback, and DeepSeek requests | — |
| [`platform-user/`](platform-user/README.md) | Defines enterprise platform-user governance: approval, platform roles, and account status over an external auth subject | `ctx.platformUsers` |
| [`platform-user-supabase/`](platform-user-supabase/README.md) | Registers a Supabase-backed provider for `ctx.platformUsers` | registers on `ctx.platformUsers` |
