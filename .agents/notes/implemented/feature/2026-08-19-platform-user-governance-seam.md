# Agent Note: Platform-User Governance Seam

English | [中文](2026-08-19-platform-user-governance-seam.zh.md)

Status: implemented

## Problem

DeepSeek Harness already has anonymous identity for telemetry, but the enterprise platform work needs a governed user record on top of an authenticated subject: pending approval, platform roles, disable or lock, and restore. Putting those rules straight into a Web page or one API route would make the behavior unavailable to other hosts and would bypass the repository rule that new product behavior attaches to a documented seam.

## Decision

The enterprise platform starts with a dedicated identity-group seam, `@deepseek-ai/dsh-platform-user`, mounted as `ctx.platformUsers`.

The seam owns the Harness-side governance record, not the login handshake itself. External identity backends keep authentication, session issuance, password reset, and SSO. The seam receives an already-created auth subject and governs the corresponding platform-user record: register into `pending_approval`, approve with platform roles, change roles, disable, lock, restore, and query by platform-user id or auth subject.

The first provider is `@deepseek-ai/dsh-platform-user-supabase`. It registers into `ctx.platformUsers`, stores one governance row per auth subject in a Supabase table, validates every row at the storage boundary, and maps storage rows to the seam's stable `PlatformUser` value.

This split follows the existing capability pattern: Service Definition in one package, backend provider in another, later API and Web consumers on top.

## Alternatives considered

**Put platform-user rules straight into the Web or API layer.** This would ship faster for one surface, but it would not create a reusable product capability, would duplicate governance rules across hosts, and would conflict with the repository rule that new behavior belongs on a documented extension point.

**Fold platform-user governance into `identity/anonymous-user-id`.** That package owns a harness-home correlation id only. Mixing enterprise user records into it would conflate anonymous telemetry identity with authenticated governance state and would turn a simple utility package into an unrelated seam.

**Make Supabase the seam instead of the first provider.** That would bind the product vocabulary to one backend. The seam instead speaks in `PlatformUser` records and governance commands, so a later provider can swap the backend without rewriting consumers.

## Consequences

The identity group now contains both anonymous identity and enterprise governance.

Future API, host, and Web work consumes `ctx.platformUsers` instead of owning approval and role rules themselves.

Supabase is the first supported backend for this capability, but not the product boundary.
