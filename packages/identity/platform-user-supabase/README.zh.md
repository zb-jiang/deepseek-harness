# @deepseek-ai/dsh-platform-user-supabase

[English](README.md) | 中文

[`@deepseek-ai/dsh-platform-user`](../platform-user/README.md) 的 Supabase 后端 provider。它注册到 `ctx.platformUsers`，把每个外部 auth subject 对应的一条治理记录存进可配置的 Postgres 表，在存储边界对每条数据行做校验，再映射为 seam 稳定的 `PlatformUser` 值。

## 插件契约

- `inject = ['platformUsers']`
- `Config`
  - `url`：Supabase 项目 URL
  - `serviceRoleKey`：服务端 service-role key
  - `usersTable`：治理表名，默认 `platform_users`
- `apply(ctx, config)`：解析配置、创建一个 Supabase client，并注册 provider

provider 假定目标表暴露以下列：

- `id`
- `auth_subject`
- `login_name`
- `display_name`
- `email`
- `status`
- `platform_roles`
- `created_at`
- `created_by`
- `approved_at`
- `approved_by`
- `disabled_at`
- `disabled_by`
- `disabled_reason`
- `locked_at`
- `locked_by`
- `locked_reason`

## Model Experience

没有直接的模型可见影响。这个 provider 是企业用户治理的后端持久化适配器。

## Known Limitations and Deferred Work

- **还没有迁移包**：本包假定目标 Supabase 表已经存在，并且列和类型与预期兼容。
- **列表过滤仍在 provider 内完成**：`list({ statuses?, role? })` 目前先读取数据行再在 provider 内过滤；对 seam 来说语义正确，但还没有针对大租户规模做优化。
