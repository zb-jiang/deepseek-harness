---
description: "HTTP endpoint that permanently deletes one archived session (JSONL artifact directory plus workspace registry bookkeeping)."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-delete

English | [中文](README.zh.md)

## Summary

`dsh-session-delete` adds one route to the local webserver: `POST /api/enterprise/sessions/delete` permanently removes an archived session. Archive membership is the safety gate — an archived session has no live writes — so the endpoint deletes the JSONL artifact directory, detaches the id from every workspace's accounted list, and drops it from the registry-global archive set. Deletion converges: when the JSONL snapshot is absent (artifact already deleted externally) or the artifact directory is missing, the call skips the directory removal and clears the bookkeeping directly. The plugin carries no configuration and registers nothing model-facing.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package on any profile that runs the local webserver with JSONL session persistence and the workspace registry; the delete touchpoint then lives at `POST /api/enterprise/sessions/delete`. The plugin declares no configuration of its own — it discovers the persistence root from the mounted persistence backend, so there is nothing to point at the storage location. Callers are administrative UI (the enterprise workbench's archived-session list); the route is not part of any agent conversation flow.

### What the endpoint does

| Method | Path | Behavior |
|---|---|---|
| POST | `/api/enterprise/sessions/delete` | Body `{ "sessionId": "<id>" }`; deletes the archived session's JSONL artifact directory, detaches the id from every workspace, unarchives it, and answers `{ deleted: "<id>" }` |

Failures are JSON errors with one status per cause:

| Status | Meaning |
|---|---|
| 400 | body missing, malformed, over 64KB, or `sessionId` is not a non-empty string |
| 405 | method is not POST |
| 409 | the session is not archived; only archived sessions can be deleted |
| 500 | the persistence backend does not expose a JSONL root, or the resolved directory escapes the root |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions and points at the code; the observable behavior is covered in [Use this package](#use-this-package).

### Archive membership is the deletion gate

Deletion requires the id to sit in the registry's archived set ([src/index.ts](src/index.ts)). The archive gate blocks every `agent/pre-step` wake and an unforced archive refuses active sessions, so "archived" is exactly the condition under which no live write can still touch the artifact. Anything else answers 409.

### Artifact first, bookkeeping second

The delete sequence removes the JSONL directory, then detaches the id from every workspace's accounted list, then unarchives it from the registry-global set. A snapshot absent from persistence (artifact already deleted externally) or a missing directory skips the removal and clears the bookkeeping directly, so a failed or interrupted deletion always converges on retry. A containment check keeps the removed directory inside the persistence root before `rm` runs.

### The root is probed, not configured

The plugin copies no storage configuration: it reads the root from the mounted persistence backend's own config and rejects a non-JSONL backend with a 500 instead of guessing a directory layout.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Enterprise group README](../README.md) — the sibling enterprise packages and how the two profiles compose them.
- [Deployment architecture](../../../docs/plans/dsh_enterprise_architecture_v5.html) — where the local webserver sits in the v5 topology.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package is archived-session artifact deletion; it registers nothing model-facing.

#### KV Cache effect

Deletion happens after sessions have already ended; the endpoint touches artifact files and registry bookkeeping, never a live model context, so no cached conversation prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the package does not attempt. They are current constraints, not a task backlog.

- **Archived sessions only** — the route refuses anything the registry has not archived (409); deleting a live or merely closed session is out of scope by design.
- **JSONL backend only** — a non-JSONL persistence backend answers 500 instead of guessing a directory layout.
- **Retry-driven convergence** — a crash between the artifact delete and the bookkeeping writes leaves the id listed until a retry; the next call skips the directory removal (missing directory or absent snapshot) and converges.
- **No undelete** — removal is permanent; there is no trash, soft-delete, or restore path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The delete order mirrors the registry's own archive flow in reverse; if unarchive semantics change there, this sequence changes with them. No open work here.

</details>
