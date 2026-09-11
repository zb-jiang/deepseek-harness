# Agent Note: Todo-open skill ensure

Status: implemented

English | [中文](2026-09-11-skill-on-open-ensure.zh.md)

## Problem

Work item 2 preinstalls skills on an interval, but an employee can open a todo before the daemon's next tick — or before the very first sync — and the session would start without the referenced skills (skill-repo-design §7). `dshMeta.skillRefs` reached the web UI as a typed but unconsumed field, and `ctx.skillSync.ensureInstalled` existed only as an in-process call with no route from the browser to the employee-side service.

## Decision

skill-sync itself serves the bridge endpoint `POST /api/enterprise/skills/ensure` (prefix route alongside `/api/enterprise/auth`, the established enterprise pattern — no Typert/RPC surface for enterprise plugins). The handler validates every posted name against the bare-skill charset before it can reach the cache-directory path join, calls `ensureInstalled`, and answers with the names still missing after one immediate sync round. The same sync is now gated: concurrent daemon/login/endpoint triggers coalesce into a single in-flight round, so a double-clicked todo or a tick landing mid-install cannot interleave two downloads or state writes.

`EnterpriseWorkbench.openTask` awaits an ensure step before resolving the session binding. Already-installed skills make the step a pure local directory check with no outbound request; missing ones run the immediate round while the sidebar shows a preparing hint and disables task buttons. Anything still missing — or a failed request — records a `skillNotice` and the session opens anyway, which is the designed degraded mode: the AI session proceeds, only the `skill` tool cannot reach that skill. Tasks without `skillRefs` skip the round trip entirely.

## Alternatives considered

**Reuse the Typert `/api` JSON-RPC gateway.** It is the DSH core channel for session/workspace controllers; enterprise plugins have never registered there, and the webserver prefix route delivers the same capability without touching the core surface.

**Inject a system message into the session on failure (per §7's original wording).** `IConversation`'s public client face has no entry for appending system messages, and opening one for enterprise copy would cross the no-core-changes boundary. The sidebar notice row (the existing `prefillNotice` pattern) carries the failure visibly; retry is re-clicking the todo, which re-checks on every open.

**Block the session until skills install.** The design demands the session continue without missing skills; a hard gate would turn a SkillHub outage into employees unable to open todos at all.

## Consequences

Opening a todo always re-checks locally, so a wiped cache repairs itself on the next open even with the daemon disabled. The endpoint is unauthenticated but harmless without a verified login: `ensureInstalled` finds nothing, the sync round skips without a token, and only directory-existence answers return. The notice deliberately outlives the preparing flag (cleared when a skillRefs-free task opens) so the employee sees why a skill is missing mid-session. Unit tests pin the endpoint's 200/400/404 paths, the coalesced sync round, and the missing-name contract the web UI depends on.
