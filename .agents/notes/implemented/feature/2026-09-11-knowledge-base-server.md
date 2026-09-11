# Agent Note: Enterprise knowledge base server (web-console)

Status: implemented

English | [中文](2026-09-11-knowledge-base-server.zh.md)

## Problem

Each enterprise application needs a shared knowledge base that all its members can read and write, with documents stored in folders, image OCR feeding the search index, and a retrieval surface that later phases (management UI tab, employee-side DSH plugin) will build on. The design doc `docs/plans/2026-09-11-knowledge-base-design.md` owns the product decisions; the server piece — three `public` tables plus Supabase Storage — needed an implementation that keeps the platform's no-service-role credential discipline.

## Decision

`com.dsh.console.knowledge` implements the REST surface from design §5 (ensure-per-app KB, folder tree, document upload/list/download/delete) on top of the setup-guide §12 schema. Every request resolves the KB to its `application_id` and requires an active member (`app_memberships` active × `platform_users` active — the exact RLS predicate, reused in `KnowledgeJdbcRepository.isActiveMember`); `system_admin` bypasses membership. Writes go through the existing postgres JDBC connection (table owner, unaffected by RLS); file bytes go through Supabase Storage REST with the caller's JWT forwarded and the anon key as the `apikey` header — no service_role anywhere. Bucket provisioning reuses that same JDBC path (`INSERT INTO storage.buckets ... ON CONFLICT DO NOTHING`) when an application's KB is first opened, so no manual bucket step exists.

The parse pipeline (`KbParsePipeline` + `DocumentParser`) consumes the multipart bytes directly — it never re-reads from Storage, which is what makes the user-JWT passthrough viable on a background thread. A single-thread executor serializes Tika/OCR work (50 MB cap bounds per-document memory), writes `text_content`/`parse_status`, and marks failures `failed` with the reason. Extension-based dispatch: plain text read as UTF-8, images via tess4j (`chi_sim+eng`, `TESSDATA_PATH` required or the document fails parsing), pdf/office via Tika, unknown types go `ready` with no text (name-only search). Search is `ILIKE` over name + `text_content` restricted to `ready` rows; list payloads carry an excerpt window (match ±80/160 chars, else first 200) instead of full text. `KB_MAX_UPLOAD_MB` drives both the Spring multipart limit and `KnowledgeProperties`.

## Alternatives considered

**Service role key for Storage access.** It would remove the user-JWT dependency but violates the platform's credential discipline (no shared elevated secret); the passthrough also means RLS alone enforces membership on every object read.

**Persisted parse queue.** Surviving restarts would need a durable queue for at most hundreds of documents whose failure mode (stuck `pending`) is visible and fixed by re-upload; the queue machinery was not worth it for phase 1.

**tsvector search.** Chinese tokenization needs zhparser/pgroonga whose Supabase availability is unverified; `ILIKE` over the same `text_content` column keeps the phase-2 vector path (which reads that column) unchanged.

## Consequences

Phase 2 (management UI tab) and phase 3 (employee-side plugin: proxy routes, `kb_search`/`kb_read`/`kb_list` tools, session selector, workspace upload) call these endpoints as-is; the invariant that non-`ready` documents never enter search results must be re-imposed by each consumer. `GET /api/apps/{appId}/kb` provisions on first member visit, so an application's KB exists implicitly once any member opens it. Restart orphans are limited to `pending` rows and Storage objects from failed transactions; there is no GC for either — acceptable at the design scale.
