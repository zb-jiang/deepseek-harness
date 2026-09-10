# Enterprise

[English](README.md) | 中文

企业平台应用层：平台用户治理 HTTP API 路由。

## 包

| 包 | 职责 |
|------|------|
| [`@deepseek-ai/dsh-platform-user-api`](platform-user-api/) | 平台用户治理 HTTP API 路由（注册、审批、禁用、锁定、恢复、角色管理） |
| [`@deepseek-ai/dsh-user-identity-context`](user-identity-context/) | 会话身份上下文：`ctx.currentUser` 缓存 + 每轮注入模型可见的身份块 |
