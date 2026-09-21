# Agent Note: Countersign Voting Rule (dsh:votingRule)

Status: implemented

English | [中文](2026-09-15-voting-rule.zh.md)

## Problem

Multi-instance countersign completion conditions can only count finished instances, not how each instance voted. "3 out of 5 approve" written as `${nrOfCompletedInstances >= 3}` passes with 1 approval and 2 rejections. Worse, every instance submission overwrites the same result variable, so a downstream gateway sees only the last voter's value — even a `${rejected}` one-vote-veto condition breaks when an approval lands after a rejection. Counting votes by result requires aggregation on the submission path; no pure-modeling combination can produce it.

Design doc: `docs/plans/2026-09-15-voting-rule-design.md`.

## Decision

A user task may carry `dsh:votingRule` — `variable` (an output-mapping target of this node), `passValue` (what value counts as approval; any other non-empty value counts as rejection), `passCount` (early-complete threshold for approvals), and optional `rejectCount` (early-complete threshold for rejections). The pieces mirror the existing candidate-injection mechanism: like `dsh_candidates_<taskId>`, the counterss `dsh_passCount_<taskId>` / `dsh_rejectCount_<taskId>` are runtime-injected variables outside the context-declaration surface.

Since 2026-09-15 the rule also applies to plain ServiceTask and DSH backend task — same attributes, different vote sources and a listener-based counting path owned by [the multi-instance note](2026-09-15-task-multi-instance.md). This note describes the user-task path.

Three layers cooperate on the user-task path:

- **Parse time** (`DshBpmnParseHandler`): for a multi-instance user task with `votingRule` and no hand-written condition, the completion condition is generated as `${dsh_passCount_<id> >= P}` or `${dsh_passCount_<id> >= P || dsh_rejectCount_<id> >= R}` (the same condition generation covers votingRule service tasks). Hand-written conditions are never overwritten (defense in depth; publish validation rejects the combination up front).
- **Start time** (`DshMultiInstanceSetupListener`): both counters are initialized to 0 before the multi-instance splits. This is load-bearing — the generated condition is evaluated on the very first instance completion, and JUEL throws "Unknown property" on a missing variable. The listener attach condition widened from "has candidateRoleId" to "has candidateRoleId or votingRule".
- **Submission time** (`DshTaskCompletionService`): after declaration validation and before `complete()`, the raw submitted map's vote variable is stringified, compared against `passValue`, and the matching counter is incremented. Missing value (employee cleared the mapping) neither counts nor blocks. Placing aggregation after validation means a rejected submission never inflates a counter on retry.

Publish validation (`validateVotingRules`): required attributes and integer thresholds, `variable` must be among this node's output-mapping targets, the node must be multi-instance, and a hand-written `completionCondition` alongside `votingRule` is rejected. Condition-expression reference checks exempt the runtime-injected prefixes `dsh_candidates_` / `dsh_passCount_` / `dsh_rejectCount_` so gateways can route on counters directly.

Canvas: a "会签计票" group on the user-task DSH panel (vote variable dropdown sourced from this node's mapping targets); once `votingRule` is configured, the built-in multi-instance group hides `completionCondition` alongside the already-hidden `loopCardinality`.

## Alternatives considered

**Submission snapshot list.** Append each submission's variables into a `dsh_submissions_<taskId>` list and let a downstream script/delegate count votes. No new schema, but counting becomes custom code and the "3 approvals end early" semantics is unreachable — the completion condition still only counts completions.

**Teach the completion condition to count results.** Flowable's `nrOfCompletedInstances` family is engine-internal; there is no per-result counter, and instance-local variables vanish when the instance execution ends.

## Consequences

Concurrent submissions race on the counter read-modify-write; the Flowable optimistic lock turns the loser into a client-retryable error. Recorded as a known risk, not solved.

A `passCount` larger than the role's member count never fires early — the instance set ends naturally and the gateway routes on the final counts, which is still correct.

Vote values are compared after stringification, so `true` (Boolean) matches `passValue="true"`; the comparison is deliberately tolerant of JSON scalar typing.
