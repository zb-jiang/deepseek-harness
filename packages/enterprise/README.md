# Enterprise

English | [中文](README.zh.md)

Enterprise platform application layer: HTTP API routes for platform-user governance.

## Packages

| Package | Role |
|---------|------|
| [`@deepseek-ai/dsh-platform-user-api`](platform-user-api/) | HTTP API routes for platform-user governance (register, approve, disable, lock, restore, roles) |
| [`@deepseek-ai/dsh-user-identity-context`](user-identity-context/) | Session-identity context: `ctx.currentUser` cache plus a per-turn model-visible identity block |
