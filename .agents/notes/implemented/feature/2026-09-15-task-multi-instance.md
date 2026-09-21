# Agent Note: Task Multi-Instance Unification (ServiceTask / DSH Backend Task)

Status: implemented

English | [中文](2026-09-15-task-multi-instance.zh.md)

## Problem

Multi-instance was a user-task-only capability, and the two automatic nodes lacked it in different ways:

- A plain ServiceTask (custom delegate) that should process one declared `array` variable element per instance — batch OCR over N invoices, per-record enrichment — had to hand-roll its loop in Java. The canvas also still exposed the counting form (`loopCardinality`), which runs the same delegate N times with no per-instance input, and the standard-loop (rework) icon although no DSH task node supports rework.
- The DSH backend task could bind exactly one backend profile, so "3 AI profiles each review, 2 approvals advance" required three canvas nodes plus gateway wiring. The [voting rule](2026-09-15-voting-rule.md) counted votes only on the user-task submission path, leaving automatic nodes no way to vote.

Design docs: `docs/plans/2026-09-14-dsh-backend-task-design.md` (backend task multi-instance), `docs/plans/2026-09-15-voting-rule-design.md` (voting unification).

## Decision

Multi-instance is now uniform across the three task nodes; only the instance-count source differs:

- **UserTask** — count = candidate role members; the engine injects `dsh_candidates_<taskId>` (unchanged; see the voting note for its counting path).
- **Plain ServiceTask** — collection form only: `flowable:collection` names a declared `array` context variable (instance count = array length), and `flowable:elementVariable` names the variable each instance's element is injected under; the delegate reads it with `execution.getVariable(...)`. The element variable must not collide with a declared context variable (it would shadow it inside instances). `loopCardinality` on a plain service task is rejected by publish validation.
- **DSH backend task** — counting form: `loopCardinality >= 1` plus a `dsh:backendProfile` list under `dsh:backendTask`; instance *i* calls the *i*-th profile URL (`DshBackendTaskDelegate` reads the `loopCounter` local variable). The list length must equal the cardinality, and the single-instance `backendProfileUrl` attribute cannot coexist with the list. Publish validation (`validateServiceTaskMultiInstance`) enforces both shapes; `validateBackendTasks` checks every listed URL against the profile registry.

Standard loop is gone from all task nodes: the canvas replace-menu filter deletes the loop entry for UserTask and ServiceTask, and publish validation rejects `standardLoopCharacteristics` on both (user tasks were already covered).

`dsh:votingRule` now also applies to automatic nodes — same four attributes, two new vote sources and one new counting point:

- **DSH backend task**: the vote is the delegate's output mapping writing the vote variable; counted by the shared end listener below.
- **Plain ServiceTask**: the vote is whatever the delegate `setVariable`s into the (declared) vote variable; counted by the same listener.
- **userTask**: unchanged — counted in `DshTaskCompletionService` at submission time.

`DshBpmnParseHandler.attachServiceTaskVoting` attaches an end ExecutionListener (`DshVotingEndListener`) on each votingRule service task and generates the same completion condition the user task uses. The listener increments the counter matching the instance's vote value, creating either counter at 0 on first touch. Service tasks cannot reuse the user task's start-time initialization (`DshMultiInstanceSetupListener`): service-task instances create and complete interleaved — synchronously instance-by-instance inside one command, or in separate async jobs — so a start-path initialization would reset accumulated counters to 0. Completion conditions are evaluated only after an instance completes, and Flowable runs `callActivityEndListeners` before `completionConditionSatisfied`, so the listener both creates the variables before the first evaluation and makes this instance's vote visible to it.

Canvas: the community multi-instance group is hidden on service tasks; the DSH panel supplies a "多实例(集合)" group (collection dropdown restricted to declared array variables, elementVariable text field, completion condition hidden while votingRule exists) and, on backend tasks, replaces the single profile dropdown with a profile list whose row count drives `loopCardinality`. The 会签计票 group appears on all three task types with type-appropriate vote-variable sources (mapping targets for user/backend tasks, declared context variables for plain service tasks).

## Alternatives considered

**Counting-form multi-instance for plain service tasks.** The canvas already exposed `loopCardinality`, and it is the right shape for the backend task, but on a plain service task it runs the delegate N times with no per-instance input — the loop has nothing to vary. Publish validation rejects it rather than leaving a silent no-op.

**Collection-form multi-instance for the backend task.** Reusing the service-task shape would force authors to materialize a profile-URL array as a declared context variable just to hold wiring data. The node-level profile list keeps the per-instance binding visible in one place and the engine reads it without a variable round-trip.

**Counting votes in each delegate.** Every delegate would duplicate the counter read-modify-write and threshold logic, and delegates that don't cooperate would silently never count. The end listener centralizes counting over all delegate implementations.

**Initializing counters from `DshMultiInstanceSetupListener` at activity start.** Works for user tasks, whose instances are all created up front behind a wait state; on service tasks the same listener fires per instance and resets accumulated counts. Lazy creation at first vote has no such ordering constraint.

## Consequences

Backend-task profile lists bake instance bindings into the BPMN XML in a fixed order; reordering rows re-routes instances to different profiles on republish (the URL, not the row, is the contract).

A backend-task profile list row pointing at an inactive profile fails at runtime per instance and lands in the `R3/PT1M` async retry cycle; publish validation only checks registry liveness at publish time.

The service-task element variable stays collision-free only while names remain disjoint; publish validation rejects collisions, and the tutorial documents that the name must match the delegate's `getVariable` call.
