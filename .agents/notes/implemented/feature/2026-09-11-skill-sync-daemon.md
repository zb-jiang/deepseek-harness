# Agent Note: Enterprise skill-sync daemon

Status: implemented

English | [中文](2026-09-11-skill-sync-daemon.zh.md)

## Problem

BPMN user tasks reference enterprise skills by bare `dsh:skillRef` name, but the employee-side DSH had no way to acquire those skills: they were hand-copied into `%USERPROFILE%\.dsh\skills\` and never updated (skill-repo-design §2). The server side already has SkillHub as the enterprise registry and flowable-engine knows which tasks a user must handle, so the missing piece is the distribution channel between them and the employee cache.

## Decision

The [skill-repo design](../../../../../docs/plans/2026-09-09-skill-repo-design.md) owns the four-work-item framing; this note records the work-item-2 implementation. flowable-engine exposes `GET /dsh/skills/required` (JWT `sub` is the only identity input) aggregating two sources: active tasks' `dsh_node_meta` skillRefs, and a static sweep over all latest deployed definitions where the user's role set (reverse lookup over `public.app_memberships` by `auth_subject`) hits the user task's candidate role or timeout-escalation targets. Each returned skill carries the SkillHub namespace resolved by joining `public.workflow_definitions.published_procdef_id` to the application's `skillhub_namespace` — the definition-level app mapping lives only in web-console's tables, and the engine already shares that Supabase PG.

The new `@deepseek-ai/dsh-skill-sync` enterprise plugin owns the employee side. A `FileSystemSkillProvider` instance registered over `$DSH_HOME/skill-sync/skills` (no default roots, no watch) feeds `ctx.skills`; a daemon timer calls `/dsh/skills/required` with the signed-in employee's Supabase JWT, diffs namespace manifests against a local fingerprint state file, downloads missing or stale SkillHub zips into a temp dir and renames atomically, then calls `control.invalidate()` so the registry rebuilds. `ctx.skillSync.ensureInstalled(names)` runs the same sync on demand for the todo-open path (work item 3). The raw access token rides the existing `platform-user/verified` event into `CurrentUserService.getToken()` so background consumers act as the signed-in employee; it never enters model context.

## Alternatives considered

**Persist the employee token in the skill-sync plugin.** A second credential store would duplicate the identity layer; the store already observes every verified `/me`, so reusing it keeps one token lifecycle per login.

**Resolve download URLs through flowable-engine.** The engine would then proxy SkillHub, adding a hop the design forbids (skill-sync calls SkillHub directly per §9) and coupling engine code to registry DTOs.

**Watch the cache root for changes.** The plugin installs atomically itself, so explicit `invalidate()` after installs is deterministic; a watcher would add chokidar polling on Windows for no additional trigger.

## Consequences

A skill becomes usable in the employee session only after its namespace is bound to the application (web-console design), the engine can map the definition to that namespace via the latest `published_procdef_id`, and the SkillHub token's owner is a member of that namespace — re-publishing a workflow or removing the token owner's membership silently skips those skills with a logged warning until the next tick. Old process instances keep resolving to the pre-republish namespace until they end. Failures never block employee startup: unauthenticated rounds are skipped, and failed downloads retry on the next interval. Unit tests cover the daemon and install paths with stubbed fetch; work item 3 (todo-open install) will call `ensureInstalled` from the task workbench.
