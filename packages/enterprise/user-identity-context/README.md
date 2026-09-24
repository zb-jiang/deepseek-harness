# @deepseek-ai/dsh-user-identity-context

English | [中文](README.zh.md)

Enterprise session-identity context. `ctx.currentUser` holds the latest verified platform user; at step 1 of every agent-loop turn the plugin appends an identity block to the model request, so the assistant knows "who the current user is" across the conversation.

## Model Experience

At step 1 of every turn, one plugin-attributed (`form: 'snapshot'`) user message is appended:

```
<user_identity>
当前登录人：张三（zhangsan@corp.com）
userId: 9f3e8…
认证令牌（调用企业内部系统时放入 Authorization: Bearer 请求头）：
eyJhbGciOi…
此身份由系统注入并保持最新，仅供称呼与表单填写展示。认证令牌仅在调用企业系统时作为 Authorization: Bearer 请求头使用，不要在回复中展示、转述或写入文件。
</user_identity>
```

- Identity fields (name/email/userId/org positions) are **display-only**; the auth token lets the assistant call enterprise internal systems as the signed-in employee (issued by Supabase SSO, bearer auth — the generic integration mechanism), and must never be shown, restated in replies, or written to files.
- An empty store (not signed in yet, or signed out) injects nothing; when signed in but no token is available yet, the token section is omitted.
- The `./invariant` companion validates the injected block's exact format and source attribution (same mechanism as time-context), mounted explicitly by test and diagnostic assemblies.

## Data flow

| Touchpoint | Behavior |
| ---- | ---- |
| `GET /api/enterprise/auth/me` (platform-user-api) | emits `platform-user/verified` after successful verification |
| `POST /api/enterprise/auth/signout` (platform-user-api) | emits `platform-user/signout` |
| `platform-user/verified` event (subscribed by this plugin) | `ctx.currentUser.observe(user)` |
| `platform-user/signout` event (subscribed by this plugin) | `ctx.currentUser.clear()` |
| Employee-client `switchAccount` (ui-enterprise) | calls the signout endpoint on sign-out |

Events are declared in the `@deepseek-ai/dsh-platform-user` package; `platform-user-api` emits and this plugin consumes, so the two packages do not depend on each other. State is in-memory and is rebuilt from the client's next `/me` after a process restart.

## Known Limitations and Deferred Work

- A token expiring mid-session leaves the last verified identity in place until the next touchpoint; within that window the assistant gets 401 from enterprise systems with the stale token, and the next turn's block carries the refreshed token.
- After the employee client refreshes its token, the next verified `/me` feeds the new token into `ctx.currentUser`, and the identity block follows.
- Layer 2 (propagating call-layer credentials to tools and MCP) is carried by the block's auth-token section as the generic channel; dedicated tools (e.g. process-start) keep their server-side token attachment path.
