---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-04-enterprise-attribution-kinds

English | [中文](2026-10-04-enterprise-attribution-kinds.zh.md)

## Summary

Adds qualified user-identity-context and kb-context message sources for the enterprise identity display block and knowledge-base retrieval block.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-04-enterprise-attribution-kinds
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-21-user-question-reply"
    after: "b0b9a515eedc96315ecd48a5019fe1bcf610d9937a969d0f42588b85c4a75ed5"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-09-21-user-question-reply"
    after: "9d8c51ad73d913cc34ddb06309fce32021222196effb02face27c4323df163ec"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "b491393d5675b3e261706e0f27257a53c208c3f229b66bc205c1165a2e6285c1"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-09-21-user-question-reply"
    after: "84a5432c9d430ac8ee9727798648a951f955a238521b2dc3a73e3390d7bb392d"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing logs contain no such sources and remain valid. Both sources are qualified attribution on ordinary user and developer messages: ContextFormed display sections injected by the enterprise packages, read only for display grouping by the enterprise client and asserted by the package invariants. Deployments without the enterprise packages preserve the messages and derive history from their content. No event type, Session header, or format version changes.

<a id="verification"></a>
## Verification

tsx scripts/persistence-changes.ts --check passes: the eight source additions classify as attribution-only with requiresVersionBump false. tsx scripts/gen-persistence-catalog.ts --check reports docs/persistence-catalog.md, docs/persistence-catalog.zh.md, docs/persistence-catalog.i18n.yaml, packages/core/session/src/known-event-types.ts, and docs/persistence-schema.json up to date.

<a id="dev-note"></a>
## Dev Note

None.
