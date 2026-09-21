# Agent Note: DSH Backend Task and Backend Profile

Status: implemented

English | [中文](2026-09-14-dsh-backend-task-and-profile.zh.md)

## Problem

Enterprise workflows need AI generation steps that run with no human in the loop. The DSH user task already carries the right semantics — a userPrompt with `{{var.field}}` interpolation, referenced skills, and output mappings into process context variables — but every step requires a person to open the task chat, confirm the AI output, and submit the variable mapping. Scheduled or batch flows (nightly reports, automated enrichment) have no equivalent: a plain service task has no prompt/skill/mapping vocabulary, and the headless delegate spawns a throwaway process per call with no resident workspace or skill state.

Design doc: `docs/plans/2026-09-14-dsh-backend-task-design.md`.

## Decision

A DSH backend task is a distinct canvas node: a ServiceTask carrying the `dsh:backendTask backendProfileUrl=...` extension element plus the same userPrompt/skillRef/outputMappings extensions a user task uses. The web-console palette writes `delegateExpression=${dshBackendTaskDelegate}`, `async=true`, and `failedJobRetryTimeCycle=R3/PT1M` in one command-stack step; the property panel offers a profile dropdown sourced from the live registry and reuses the user-task prompt/skill/mapping editors. It has no candidate role, timeout escalation, or SoD — there is no human step for those to govern. Multi-instance arrived with [the 2026-09-15 task multi-instance note](2026-09-15-task-multi-instance.md): `loopCardinality` plus a `dsh:backendProfile` list binds instance *i* to the *i*-th profile URL.

The counterpart is the backend profile, a resident DSH instance launched with `dsh --profile enterprise-backend` (bundle `packages/bundle/enterprise-backend`, plugin `packages/enterprise/backend-task`) in its own workspace with its own LLM configuration. It registers itself with web-console on startup and then by heartbeat (`POST /api/backend-profiles/register`), runs one non-interactive agent session per submitted task, and periodically syncs the skills referenced by backend tasks whose `backendProfileUrl` points at it — the server-side counterpart of the employee-side [skill-sync daemon](2026-09-11-skill-sync-daemon.md). Multiple instances can run side by side; the node stores the URL, so choosing an instance is a flow-design decision.

The registry lives in web-console: a `backend_profiles` table (upsert by URL; heartbeat older than 5 minutes reads as inactive), skill aggregation from `workflow_definitions.published_bpmn_xml` snapshots (parse `dsh:backendTask@backendProfileUrl`, aggregate that node's skillRefs), and publish-time validation (`validateBackendTasks`: URL present and registered, delegate/async binding, prompt references, mapping targets, skillRefs).

The engine delegate completes the loop: `DshBackendTaskDelegate` interpolates the prompt with the same `DshPromptInterpolator` the user task uses, submits via `DshBackendClient` (POST create → poll GET until ready/failed/timeout), and maps the result JSON into process variables through the shared `DshVariableMappingSupport`. A root-path array target is written as a whole — no append aggregation, because an automatic node produces its complete output in one execution; a deep-path target converts by the leaf field's declared type from the variable's field list. Any failure — HTTP, timeout, task failed, non-object JSON, mapping violation — throws into the async job for the `R3/PT1M` retry cycle.

The profile contract is code-level HTTP only (`/api/backend/tasks`), never a CLI prompt submission.

## Alternatives considered

**Add a "no human" flag to the user task.** The multi-instance, candidate-role, timeout-escalation, and SoD semantics would all need conditional suppression, the completion and listener paths would branch on the flag, and the employee-side task list would need filtering. A separate node type keeps the human-task product semantics untouched.

**Spawn a headless process per call, like `DshHeadlessClient`.** A one-shot process has no resident workspace, no pre-synced skills, and no reachable HTTP endpoint; every call pays skill discovery again. The backend profile is resident precisely so its workspace and skills stay warm, and several instances with different URLs can share one server.

**Push result instead of polling.** A callback requires the profile to reach the engine and correlate a flow instance id; polling keeps the profile stateless toward callers and survives profile restarts. The in-memory task table is acceptable because the engine's async job retry covers a lost task.

## Consequences

The profile URL is baked into the BPMN XML: moving a profile to a new address means editing the flows that point at it and republishing.

The profile's task table is in-process memory; a restart drops running tasks. The engine's retry cycle is the recovery path, so profile restarts should be quick relative to `R3/PT1M`.

Registration is global — any backend task can target any registered instance; per-application binding and service-account login (which would let knowledge-base tools enter backend sessions) are deferred.

Prompt interpolation and output-mapping semantics are now shared code between the user-task and backend-task paths, so a change to `DshPromptInterpolator` or `DshVariableMappingSupport` applies to both; the engine test suite pins both consumers.
