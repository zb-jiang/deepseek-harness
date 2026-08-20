# Supabase 配置手册：平台用户治理

本手册指导你在 Supabase 中配置 `platform_users` 表和认证，使 `@deepseek-ai/dsh-platform-user-supabase` Provider 可正常工作。

## 1. 创建 Supabase 项目

1. 访问 [https://supabase.com](https://supabase.com)，注册或登录
2. 点击 **New Project**，填写项目名称（如 `dsh-enterprise`）
3. 设置数据库密码，选择区域（建议选离用户最近的区域）
4. 等待项目初始化完成（约 2 分钟）

## 2. 获取项目凭据

进入 **Project Settings -> API**，记录以下信息：

| 凭据 | 字段名 | 获取方式 |
|------|--------|---------|
| Project URL | `url` | 页面顶部显示的完整地址，形如 `https://<project-ref>.supabase.co`（`.co` 结尾，不是 `.com`；`<project-ref>` 是一串约 20 位的随机字母数字 ID） |
| service_role key | `serviceRoleKey` | 页面下方 **Project API keys** 区域，找到 `service_role` 行，点击 **Reveal** 显示后复制（形如 `eyJhbGci...` 的长字符串） |
| anon key | `anonKey` | 同一区域，找到 `anon` / `public` 行，点击 **Reveal** 显示后复制。前端认证（注册/登录）需要此 key |

> **警告**：`service_role key` 拥有完全数据库访问权限，仅可在服务端使用，不可暴露到前端。

## 3. 创建数据库表

进入 **SQL Editor**，粘贴并执行以下 SQL：

```sql
-- 平台用户治理表
CREATE TABLE platform_users (
    -- 主键，UUID，默认自动生成
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 认证主体标识，对应 Supabase Auth 的 user.id
    auth_subject TEXT NOT NULL,

    -- 平台登录名，唯一
    login_name TEXT NOT NULL,

    -- 显示名称
    display_name TEXT NOT NULL,

    -- 邮箱，唯一
    email TEXT NOT NULL,

    -- 用户状态：pending_approval / active / disabled / locked
    status TEXT NOT NULL DEFAULT 'pending_approval'
        CHECK (status IN ('pending_approval', 'active', 'disabled', 'locked')),

    -- 平台角色数组：system_admin / app_admin / normal_user
    platform_roles TEXT[] NOT NULL DEFAULT '{}',

    -- 创建记录
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,

    -- 审批记录
    approved_at TIMESTAMPTZ,
    approved_by UUID,

    -- 禁用记录
    disabled_at TIMESTAMPTZ,
    disabled_by UUID,
    disabled_reason TEXT,

    -- 锁定记录
    locked_at TIMESTAMPTZ,
    locked_by UUID,
    locked_reason TEXT
);

-- 唯一约束
ALTER TABLE platform_users
    ADD CONSTRAINT uq_platform_users_auth_subject
    UNIQUE (auth_subject);

ALTER TABLE platform_users
    ADD CONSTRAINT uq_platform_users_login_name
    UNIQUE (login_name);

ALTER TABLE platform_users
    ADD CONSTRAINT uq_platform_users_email
    UNIQUE (email);

-- 查询索引（按状态和角色筛选是常用操作）
CREATE INDEX idx_platform_users_status ON platform_users (status);
CREATE INDEX idx_platform_users_platform_roles ON platform_users USING GIN (platform_roles);

-- 审计日志表
CREATE TABLE audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    target_user_id UUID,
    operator_id UUID,
    details JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_events_created_at ON audit_events (created_at DESC);
CREATE INDEX idx_audit_events_target_user_id ON audit_events (target_user_id);
```

## 4. 配置行级安全（RLS）

```sql
-- 启用 RLS
ALTER TABLE platform_users ENABLE ROW LEVEL SECURITY;

-- service_role 已经绕过 RLS，无需额外策略
-- 如果后续前端需要直接读取（不推荐），再加 SELECT 策略
```

> Provider 使用 `service_role key`，所有操作绕过 RLS。前端不应直接操作此表。

## 5. 配置 Supabase Auth

平台用户治理表与 Supabase Auth 分离：

- **Supabase Auth** 负责注册、登录、密码、SSO
- **`platform_users` 表** 负责治理状态（审批、角色、禁用、锁定）

用户注册流程：
1. 用户通过 Supabase Auth 注册 → 获得 `user.id`
2. 系统在 `platform_users` 表插入一行，`auth_subject = user.id`，`status = 'pending_approval'`
3. 管理员审批后 `status` 改为 `active`

### 5.1 认证提供方配置

进入 **Authentication → Providers**，按需启用：

| 提供方 | 配置项 |
|--------|--------|
| Email | 默认启用，可配置确认邮件模板 |
| GitHub | OAuth App 的 Client ID / Secret |
| Google | OAuth 2.0 Client ID / Secret |

### 5.2 关闭公开注册（可选）

如果只允许管理员创建用户，进入 **Authentication → Settings**：

- 关闭 **Allow new users to sign up**
- 改为管理员通过 API 创建用户

## 6. 插入初始系统管理员

项目初始化后，需要手动创建第一个系统管理员：

```sql
-- 先在 Supabase Auth 中注册一个用户，拿到 user.id
-- 然后执行：
INSERT INTO platform_users (
    auth_subject,
    login_name,
    display_name,
    email,
    status,
    platform_roles,
    approved_at,
    approved_by
) VALUES (
    '<你的 Supabase Auth user.id>',  -- 替换为实际值
    'admin',
    '系统管理员',
    'admin@example.com',
    'active',
    '{system_admin}',
    now(),
    gen_random_uuid()
);
```

> **重要**：初始管理员需要在 Supabase Auth 中创建对应的认证用户（Authentication -> Users -> Add user），才能在界面上登录。`auth_subject` 填入该用户的 `user.id`。
