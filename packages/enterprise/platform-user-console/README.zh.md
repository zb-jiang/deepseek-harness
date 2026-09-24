# @deepseek-ai/dsh-platform-user-console

[English](README.md) | 中文

[`@deepseek-ai/dsh-platform-user`](../platform-user/README.zh.md) 能力缝的 Web Console provider。它注册进 `ctx.platformUsers`,用 JWKS 本地验证 Supabase Auth JWT,再携带用户自己的 bearer token 从 Web Console 后端(`GET /api/users/me`)读取当前用户的治理记录。

## 插件契约

- `inject = ['platformUsers']`
- `Config`
  - `supabaseUrl` — Supabase 项目 URL;仅其 Auth issuer 用于 JWT 验证
  - `webConsoleBaseUrl` — Web Console 后端基地址,默认 `http://127.0.0.1:8080`
- `apply(ctx, config)` — 解析配置,创建 JWKS key store,注册 provider

provider 假定 Web Console 的 `GET /api/users/me` 端点返回 `ApiResponse` 信封(`{ success, data, error }`),其 `data` 为 camelCase 治理记录(`id`、`authSubject`、`loginName`、`displayName`、`email`、`status`、`platformRoles`、`createdAt` 及可选的审批/禁用/锁定留痕字段)。未知字段(如 `orgUnits`)被忽略。

## 不变量

无运行时不变量:本 provider 是薄传输适配器,本地验证 JWT 后每个请求读取一个后端端点,没有可检查的持久关系。

## 模型体验

对模型无直接影响。本 provider 是企业用户治理的后端身份适配器。

## 已知限制与延期工作

- **待审批用户读到 `pending_approval`** — seam 值保留后端状态;由消费方决定待审批用户能否继续操作。
