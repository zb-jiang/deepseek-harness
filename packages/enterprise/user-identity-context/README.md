# @deepseek-ai/dsh-user-identity-context

English | [中文](README.zh.md)

Enterprise session-identity context. `ctx.currentUser` holds the latest verified platform user; at step 1 of every agent-loop turn the plugin appends an identity block to the model request, so the assistant knows "who the current user is" across the conversation.

## Model Experience

At step 1 of every turn, one plugin-attributed (`form: 'snapshot'`) user message is appended:

```
<user_identity>
当前登录人：张三（zhangsan@corp.com）
userId: 9f3e8…
此身份由系统注入并保持最新，仅供称呼与表单填写展示。鉴权由系统在调用层自动完成，不要在工具参数中传递或虚构身份。
</user_identity>
```

- The identity block is **display-only**: authorization always travels through call-layer credentials (JWT) and is never restated by the model.
- An empty store (not signed in yet, or signed out) injects nothing.
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

- A token expiring mid-session leaves the last verified identity in place until the next touchpoint — a same-human staleness window that is benign because the block is display-only.
- Layer 2 (propagating call-layer credentials to tools and MCP) is not implemented; the authorization path remains the existing proxy pass-through.
