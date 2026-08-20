# identity/ — 共享身份

[English](README.md) | 中文

跨产品领域共享的身份与治理值。有些包保存匿名或外部认证相关的关联 id；另一些包定义叠加在外部身份后端之上的 Harness 侧治理记录。

| 包 | 职责 | ctx key |
|---|---|---|
| [`anonymous-user-id/`](anonymous-user-id/README.md) | 为遥测、反馈和 DeepSeek 请求持久化一个限定于 Harness home 的匿名关联 id | — |
| [`platform-user/`](platform-user/README.md) | 定义企业平台用户治理：围绕外部 auth subject 的审批、平台角色和账号状态 | `ctx.platformUsers` |
| [`platform-user-supabase/`](platform-user-supabase/README.md) | 为 `ctx.platformUsers` 注册 Supabase 后端 provider | 注册到 `ctx.platformUsers` |
