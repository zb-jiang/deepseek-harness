# Agent Note: Session Identity Context

Status: implemented

English | [中文](2026-09-09-session-identity-context.zh.md)

## Problem

The employee client authenticates through Supabase, but nothing told the model who the current user is. The expense-reimbursement flow's first user task made the employee re-type their own name and id, and any model-stated identity is fabricated input that can silently poison process variables. Tool and MCP calls must never carry identity as authorization, so the fix has to separate what the model may *know* (display) from what actually authorizes (call-layer credentials).

This is layer 1 of the enterprise identity-propagation design: give the assistant a reliable, fresh, display-only statement of the logged-in user.

## Decision

A new enterprise package, `@deepseek-ai/dsh-user-identity-context`, owns both the identity cache and the model-visible injection.

`ctx.currentUser` (`CurrentUserService`) remembers the latest verified platform user in memory. The cache is fed by two emit events, declared on the `@deepseek-ai/dsh-platform-user` seam and emitted by `platform-user-api`: `platform-user/verified` fires after every verified `GET /api/enterprise/auth/me` response, and `platform-user/signout` fires on the new `POST /api/enterprise/auth/signout` touchpoint. The plugin subscribes to both with global listeners; the events emit into the void when the plugin is absent, and the store stays empty when the API routes are absent.

The injection listens on `agent/pre-step` (prepended) and appends one `<user_identity>` snapshot user message at step 1 of every turn: a plugin-attributed message (`form: 'snapshot'`, one section) whose fixed wording carries the display name, email, and userId plus a discipline line — display only, authorization stays in call-layer credentials. Reject decisions and already-aborted steps pass through untouched, and an empty store injects nothing. Later steps of the same turn do not repeat the block; a re-login appears from the next turn on.

The package-owned invariant companion (`./invariant`, same mechanism as time-context) pins the exact block format, non-blank fields, the session position (inside an open turn and step, before `request/header`), and that the message source carries only the exact snapshot text — the durable log cannot accumulate a mutated identity block.

The `ui-enterprise` account switch notifies the signout touchpoint before clearing its local token, so the webserver cache forgets the identity in the same gesture.

Registered only by the `enterprise-app` bundle patch; no default profile changes.

## Alternatives considered

**A system-prompt section.** Prompt sections are assembled per request, but the established durable mechanism for per-turn model context is the plugin snapshot message with invariant validation and section provenance (the time-context precedent); a prompt section would bypass that vocabulary and complicate the invariant story.

**Passing identity through tool or MCP arguments.** That makes the model an identity transport: a fabricated or injected value is indistinguishable from a real one at the tool boundary. Rejected for security; the discipline line in the block forbids it.

**Observing inside the `platformUsers` seam (wrap `getUserByToken`).** Every token read, not just explicit auth touchpoints, would mutate the cache, and the cache would depend on provider internals. Touchpoint events keep the observation explicit.

**Hard inject dependency from `platform-user-api` to this plugin.** That would force the `agents` service to load for pure auth surfaces and couple two independently useful packages.

## Consequences

Every turn costs one extra user-role message of about four lines. The identity reflects the latest verified touchpoint; a token expiring mid-session leaves the last verified identity in place until the next touchpoint — a same-human staleness window that is benign because the block is display-only. A restarted webserver rebuilds the cache at the client's next `/me`.

Layer 2 — propagating call-layer credentials to tools and MCP — remains the authorization path and is out of scope here.

## Testing

Package suites pin the injection timing, per-turn cadence, reject/abort pass-through, event wiring, and the loader export path; the invariant suite pins format, position, provenance, and late-registration validation. `platform-user-api` suites pin the `platform-user/verified` emission on success, no emission on failure, and the signout route's 204 plus event.

## Deferred

The model-visible behavior change has no keyless assembled-application snapshot yet; the snapshot-harness support for an enterprise-profile example is still open work.
