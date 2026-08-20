# @deepseek-ai/dsh-platform-user

[English](README.md) | 中文

平台用户治理 Service Definition（`ctx.platformUsers`）。这条 seam 保存叠加在外部身份后端之上的 Harness 侧治理记录，例如基于 Supabase Auth 的注册后进入 `pending_approval`、平台角色分配、按 auth subject 查询、管理员禁用或锁定，以及恢复到 `active`。

## Service API

- `registerProvider(provider)`：挂载唯一活动 provider。重复 provider 会以 `PlatformUserError` 代码 `DUPLICATE_PROVIDER` 失败。
- `registerPendingUser(request)`：在外部身份后端创建 subject 之后，创建一条待审批治理记录。
- `getById(id)` / `getByAuthSubject(authSubject)`：读取单条记录。
- `list({ statuses?, role? })`：列出匹配记录。
- `approve(id, { approvedBy, platformRoles })`：只允许审批 `pending_approval` 用户，并写入初始平台角色集。
- `setRoles(id, { changedBy, platformRoles })`：整体替换现有用户的平台角色集。
- `disable(id, { disabledBy, reason? })` / `lock(id, { lockedBy, reason? })`：管理员状态变更。
- `restore(id, { restoredBy })`：把 `disabled` 或 `locked` 用户恢复到 `active`。

这条 seam 会在调用 provider 之前校验角色名、拒绝重复角色，并拒绝非法状态迁移。

## Model Experience

没有直接的模型可见影响。API gateway、Web 管理界面等 consumer 决定向人或模型暴露哪些平台用户治理能力。

## Known Limitations and Deferred Work

- **尚无认证会话 seam**：本包只治理 Harness 侧用户记录；登录、令牌刷新、密码重置和 SSO 握手仍留在外部身份后端及后续 consumer 包中。
- **尚无内置审计流**：这条 seam 直接返回更新后的记录；后续的 consumer 或 companion 包应补充持久化治理审计事件。
