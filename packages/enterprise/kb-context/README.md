# @deepseek-ai/dsh-kb-context

English | [中文](README.zh.md)

Enterprise session knowledge-base context for the employee harness. The client reports which application each task session belongs to, and the plugin appends a model-visible block carrying that application's knowledge base id at step 1 of every turn, so the assistant can call `kb_search` / `kb_list` / `kb_read` without an '@'-inserted document first.

## Injected block

Sessions with a reported application whose kb resolves inject one durable block per turn:

```text
<knowledge_base>
本会话所属应用的知识库：
kbId: <id>
名称：<name>
检索用 kb_search(kbId, query)，浏览清单用 kb_list(kbId)，读取全文用 kb_read(docId)；用户以 '@' 插入的知识库文档即来自此库。
此归属由系统注入并保持最新，仅供企业知识库检索使用。
</knowledge_base>
```

Sessions without a report (ordinary chats, tasks of applications without a kb, cleared bindings) inject nothing.

## Report channel

`POST /api/enterprise/kb/session-context` (exact route on the local webserver) with the employee JWT and `{ "entries": [{ "sessionId": "...", "applicationId": "..." | null }] }`. The client (`@deepseek-ai/dsh-ui-enterprise`) reports on new bindings, replays persisted bindings after each task-list refresh, and reports `null` on completion. The map is in-memory; a webserver restart re-learns it from the client's next replay sweep.

Forged reports cannot escalate: kb resolution always re-fetches web-console's by-application endpoint with the signed-in employee's JWT, and non-members get 404 → no block.

## Config

| Field | Type | Description |
| --- | --- | --- |
| `webConsoleBaseUrl` | volatile string | web-console base URL (protocol + host, no path); used to resolve an application's kb. |

## Invariants

The `./invariant` companion pins the block's durable format and position (inside an open step, before `request/header`), so replayed logs reject rewritten blocks.
