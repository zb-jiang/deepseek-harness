# Supabase 配置手册:企业级应用平台

本手册指导你在 Supabase 中完成 DSH 企业级应用平台所需的全部配置,覆盖认证中心、统一存储和各组件连接。

平台采用"认证直连 Supabase"模型:员工端 DSH Electron APP 和 Web Console 后端都直连 Supabase Auth 完成登录,后端用 Supabase 签发的 JWT 本地验证,不互相做认证中介。

## 0. 命名约定

SPEC 中对象字段使用 camelCase(如 `loginName`、`appAdminUserIds`),数据库表使用 snake_case(如 `login_name`、`app_admin_user_ids`)。Java/Node 代码层用 camelCase,通过 ORM 或映射层与数据库 snake_case 互转。本手册 SQL 一律使用 snake_case。

数组类型字段(如 `app_admin_user_ids`、`role_ids`、`visibility_roles`)使用 PostgreSQL 的 `UUID[]` 或 `TEXT[]`,元素为引用对象的 UUID。数组外键约束 PostgreSQL 不原生支持,由应用层校验引用完整性。

## 1. 创建 Supabase 项目

1. 访问 [https://supabase.com](https://supabase.com),注册或登录
2. 点击 **New Project**,填写项目名称(如 `dsh-enterprise`)
3. 设置数据库密码,选择区域(建议选离用户最近的区域)
4. 等待项目初始化完成(约 2 分钟)

> 记住数据库密码,Java 组件(Flowable 引擎、Web Console 后端)需要用它直连 Postgres。

## 2. 获取项目凭据

进入 **Project Settings → API**,记录以下信息:

### 2.1 Supabase API 凭据(给 Node 和前端认证用)

| 凭据 | 字段名 | 获取方式 |
|------|--------|---------|
| Project URL | `url` | 页面顶部完整地址,形如 `https://<project-ref>.supabase.co`(`.co` 结尾;`<project-ref>` 是约 20 位随机字母数字 ID) |
| service_role key | `serviceRoleKey` | **Project API keys** 区域 `service_role` 行,点 **Reveal** 复制(形如 `eyJhbGci...`) |
| anon key | `anonKey` | 同区域 `anon` / `public` 行,点 **Reveal** 复制。前端认证(注册/登录)需要此 key |

> **警告**:`service_role key` 拥有完全数据库访问权限,仅可在服务端使用,不可暴露到前端。

### 2.2 数据库连接信息(给 Java 组件直连 Postgres 用)

进入 **Project Settings → Database**,记录以下信息:

| 凭据 | 用途 |
|------|------|
| Host | 直连:`db.<project-ref>.supabase.co`;连接池(Supavisor):`aws-0-<region>.pooler.supabase.com` |
| Port | 直连 `5432`;连接池 session 模式 `5432`,transaction 模式 `6543` |
| Database | `postgres` |
| User | 直连:`postgres`;连接池:`postgres.<project-ref>` |
| Password | 第 1 步设置的项目数据库密码 |

**连接方式选择**:

- **直连(Direct)**:`jdbc:postgresql://db.<project-ref>.supabase.co:5432/postgres`,user `postgres`。支持 DDL,Flowable 引擎建表必须用直连。
- **连接池 Session 模式**:`jdbc:postgresql://aws-0-<region>.pooler.supabase.com:5432/postgres`,user `postgres.<project-ref>`。适合长连接,不支持 DDL 在事务中。
- **连接池 Transaction 模式**:port `6543`,pgBouncer 兼容,**不支持 DDL**,Flowable 建表不能用。

V1 建议:Flowable 引擎建表阶段用直连,运行时也用直连(单企业单实例,连接数够用);Web Console 后端用直连。

### 2.3 JWT Secret(给 Java 后端验证 Supabase Auth 签发的 JWT)

进入 **Project Settings → API → JWT Settings**,点 **Reveal** 显示 **JWT Secret**,复制保存。

此 secret 用于验证 Supabase Auth 签发的 access token(HS256 算法)。Flowable 引擎和 Web Console 后端用它在本地验证 JWT 签名,从 JWT 提取 `sub`(即 Supabase Auth 的 `user.id`),无需每次请求都调 Supabase API。这是"认证直连 Supabase"的技术实现:Supabase 签发 JWT,各后端用 secret 本地验证。

> **安全**:JWT Secret 是签名密钥,泄露后可伪造任意用户 JWT。仅在服务端使用,不可提交到代码仓库,通过环境变量注入。

## 3. 创建数据库 Schema

DSH 企业平台使用两个 schema:平台所有业务表都在 `public` schema(Supabase 默认,无需创建),Flowable 引擎的 `ACT_*` 表在 `flowable` schema。进入 **SQL Editor**,执行:

```sql
-- public schema 是 Supabase 默认 schema,无需创建
-- 平台用户治理、企业治理元数据表都建在 public schema 下

-- 流程引擎(Flowable 引擎使用,JDBC 直连,自动建 ACT_* 表)
CREATE SCHEMA IF NOT EXISTS flowable;

-- postgres 是超级用户,自动拥有所有 schema 权限,无需额外 grant
-- 生产环境建议创建专用角色,见第 7 节
```

## 4. 平台用户治理表(public schema)

由 Node `platform-user-supabase` Provider 通过 Supabase API 操作,记录平台登录主体与治理状态。

```sql
-- 平台用户治理表
CREATE TABLE public.platform_users (
    -- 主键,UUID,默认自动生成
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- 认证主体标识,对应 Supabase Auth 的 user.id
    auth_subject TEXT NOT NULL,

    -- 平台登录名,唯一
    login_name TEXT NOT NULL,

    -- 显示名称
    display_name TEXT NOT NULL,

    -- 邮箱,唯一
    email TEXT NOT NULL,

    -- 用户状态:pending_approval / active / disabled / locked
    status TEXT NOT NULL DEFAULT 'pending_approval'
        CHECK (status IN ('pending_approval', 'active', 'disabled', 'locked')),

    -- 平台角色数组:system_admin / app_admin / normal_user
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
ALTER TABLE public.platform_users
    ADD CONSTRAINT uq_platform_users_auth_subject
    UNIQUE (auth_subject);

ALTER TABLE public.platform_users
    ADD CONSTRAINT uq_platform_users_login_name
    UNIQUE (login_name);

ALTER TABLE public.platform_users
    ADD CONSTRAINT uq_platform_users_email
    UNIQUE (email);

-- 查询索引
CREATE INDEX idx_platform_users_status ON public.platform_users (status);
CREATE INDEX idx_platform_users_platform_roles ON public.platform_users USING GIN (platform_roles);

-- 审计日志表
CREATE TABLE public.audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    target_user_id UUID,
    operator_id UUID,
    details JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_events_created_at ON public.audit_events (created_at DESC);
CREATE INDEX idx_audit_events_target_user_id ON public.audit_events (target_user_id);
```

## 5. 企业治理元数据表(public schema)

由 Web Console 后端(Java Spring Boot)通过 JDBC 直连操作,与平台用户治理表同在 `public` schema。记录应用、角色、成员、资源、流程定义等治理对象。字段依据开发 SPEC 4.2-4.8 定义。

```sql
-- 5.1 应用表(SPEC 4.2 Application)
CREATE TABLE public.applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    -- 状态:draft / active / suspended / archived(archived 为终态)
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'suspended', 'archived')),
    workspace_id TEXT NOT NULL,
    -- 应用管理员列表,引用 platform_users.id,至少一个
    app_admin_user_ids UUID[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    archived_at TIMESTAMPTZ,
    archived_by UUID
);

CREATE INDEX idx_applications_status ON public.applications (status);

-- 5.2 应用角色表(SPEC 4.3 AppRole)
-- 支持角色继承(V1):parent_role_id 指向父角色,上级继承下级权限并可处理下级待办
-- SoD(职责分离)V1 为运行时校验,不在此表存储互斥配置
CREATE TABLE public.app_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.applications(id),
    -- 应用内角色名唯一
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    -- 父角色 id,nullable 表示顶级角色;上级继承下级权限
    -- 必须指向同一应用内的角色(应用层校验 app_id 一致);不允许循环引用(应用层校验)
    parent_role_id UUID REFERENCES public.app_roles(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    UNIQUE (app_id, name),
    -- 防止自引用
    CHECK (parent_role_id IS NULL OR parent_role_id <> id)
);

CREATE INDEX idx_app_roles_app_id ON public.app_roles (app_id);
CREATE INDEX idx_app_roles_parent ON public.app_roles (parent_role_id);

-- 5.3 应用成员表(SPEC 4.4 AppMembership)
CREATE TABLE public.app_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.applications(id),
    -- 跨 schema 引用 platform_users.id
    user_id UUID NOT NULL REFERENCES public.platform_users(id),
    -- 绑定的角色 id 数组,引用 app_roles.id,应用层校验完整性
    role_ids UUID[] NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by UUID,
    -- 同一用户同一应用只有一条有效记录
    UNIQUE (app_id, user_id)
);

CREATE INDEX idx_app_memberships_app_id ON public.app_memberships (app_id);
CREATE INDEX idx_app_memberships_user_id ON public.app_memberships (user_id);

-- 5.4 资源目录(不建表)
-- V1 不在企业层维护资源目录;skill/mcp/llm 由 DSH 运行时管理,
-- 节点通过 BPMN extensionElements 的 skillRefs 引用,员工 PC 定时任务预装(见 SPEC §9.4)。

-- 5.5 流程定义表(SPEC 4.6 WorkflowDefinition)
-- 仅存 Flowable 不管的治理元数据 + 草稿 BPMN;版本/节点定义/实例/任务由 Flowable ACT_* 表管理。
-- 流程版本(SPEC 4.7 WorkflowVersion)映射到 Flowable ACT_RE_PROCDEF,不建独立表。
-- 节点定义(SPEC 4.8)的 DSH 特有元数据(assignmentRule/inputSchema/outputSchema/
-- resourceBindings/timeoutPolicy/SoD 规则)写在 BPMN XML 的 dsh: extensionElements,随 BPMN 单一存储。
CREATE TABLE public.workflow_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.applications(id),
    name TEXT NOT NULL,
    description TEXT,
    -- 状态:draft(草稿编辑) / published(已发布到 Flowable) / disabled(停用) / archived(归档,终态)
    -- disabled 和 archived 都不允许新实例启动
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'published', 'disabled', 'archived')),
    -- 草稿 BPMN XML(未发布时在 Web Console 编辑;发布后可保留作回退参考)
    draft_bpmn_xml TEXT,
    -- 发布后指向 Flowable(跨 schema 不加外键,仅存引用;Flowable deployment 与 procdef 的 ID)
    published_deployment_id VARCHAR(64),
    published_procdef_id VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    updated_at TIMESTAMPTZ,
    updated_by UUID
);

CREATE INDEX idx_workflow_definitions_app_id ON public.workflow_definitions (app_id);
CREATE INDEX idx_workflow_definitions_status ON public.workflow_definitions (status);
```

## 6. 流程引擎表(flowable schema)

Flowable 7 引擎启动时根据配置自动在 `flowable` schema 创建 `ACT_*` 系列表(前缀来自前身 Activiti),包括:

| 前缀 | 含义 | 关键表 |
|------|------|--------|
| `ACT_RE_*` | Repository 仓库 | `ACT_RE_DEPLOYMENT`(部署)、`ACT_RE_PROCDEF`(流程定义)、`ACT_GE_BYTEARRAY`(BPMN XML) |
| `ACT_RU_*` | Runtime 运行时 | `ACT_RU_EXECUTION`(执行实例)、`ACT_RU_TASK`(用户任务)、`ACT_RU_VARIABLE`(变量)、`ACT_RU_JOB`(异步 job) |
| `ACT_HI_*` | History 历史 | `ACT_HI_PROCINST`(历史实例)、`ACT_HI_TASKINST`(历史任务)、`ACT_HI_ACTINST`(历史活动) |
| `ACT_ID_*` | Identity 身份 | `ACT_ID_USER`、`ACT_ID_GROUP`、`ACT_ID_MEMBERSHIP` |
| `ACT_GE_*` | General 通用 | `ACT_GE_PROPERTY`(引擎属性、schema version) |

无需手动建表。Flowable 引擎配置 `spring.flowable.database-schema=flowable` 和 `spring.flowable.database-schema-update=true` 后,首次启动自动建表。DSH 不直接操作这些表,全部通过 Flowable Java API 或 REST API 间接访问。

第 3 步已创建 `flowable` schema,`postgres` 超级用户自动拥有权限。生产环境用专用角色时,需 `GRANT ALL ON SCHEMA flowable TO flowable_role;`。

## 7. 配置行级安全(RLS)

### 7.1 V1 起步:超级用户绕过

V1 单企业单实例部署,Java 组件(Flowable 引擎、Web Console 后端)用 `postgres` 超级用户直连,自动绕过所有 RLS。Node `platform-user-supabase` 用 `service_role key` 也绕过 RLS。无需配置 RLS 策略。

```sql
-- 启用 RLS(postgres 超级用户和 service_role 自动绕过)
ALTER TABLE public.platform_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

-- 治理元数据表同样启用 RLS,Java 用 postgres 超级用户绕过
ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_definitions ENABLE ROW LEVEL SECURITY;
```

### 7.2 生产环境:专用角色与策略(可选,V2)

生产环境建议为每个 Java 组件创建专用数据库角色,限制权限:

```sql
-- Flowable 引擎专用角色:flowable schema 的 DDL + DML
CREATE ROLE flowable_role WITH LOGIN PASSWORD '<强密码>';
GRANT USAGE ON SCHEMA flowable TO flowable_role;
GRANT ALL ON SCHEMA flowable TO flowable_role;
GRANT ALL ON ALL TABLES IN SCHEMA flowable TO flowable_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA flowable GRANT ALL ON TABLES TO flowable_role;

-- Web Console 后端专用角色:治理元数据表 DDL + DML,platform_users/audit_events 只读
CREATE ROLE webconsole_role WITH LOGIN PASSWORD '<强密码>';
GRANT USAGE ON SCHEMA public TO webconsole_role;
-- 治理元数据表:DDL + DML(applications/app_roles/app_memberships/workflow_definitions)
GRANT ALL ON public.applications, public.app_roles, public.app_memberships,
    public.workflow_definitions
    TO webconsole_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO webconsole_role;
-- platform_users / audit_events 只读(显示用户列表、审计查看)
GRANT SELECT ON public.platform_users, public.audit_events TO webconsole_role;
```

专用角色不是超级用户,RLS 会生效。需为每张表配置 RLS 策略允许该角色访问,或 `BYPASSRLS` 属性给角色(简化但不安全)。V2 再细化。

## 8. 配置 Supabase Auth

平台用户治理表与 Supabase Auth 分离:

- **Supabase Auth** 负责注册、登录、密码、SSO、签发 JWT
- **`platform_users` 表** 负责治理状态(审批、角色、禁用、锁定)

用户注册流程:
1. 用户通过 Supabase Auth 注册 → 获得 `user.id`
2. 系统在 `platform_users` 表插入一行,`auth_subject = user.id`,`status = 'pending_approval'`
3. 系统管理员审批后 `status` 改为 `active`
4. 用户登录后,Supabase Auth 签发 JWT,各后端用 JWT Secret 验证

### 8.1 认证提供方配置

进入 **Authentication → Providers**,按需启用:

| 提供方 | 配置项 |
|--------|--------|
| Email | 默认启用,可配置确认邮件模板 |
| GitHub | OAuth App 的 Client ID / Secret |
| Google | OAuth 2.0 Client ID / Secret |

### 8.2 关闭公开注册(可选)

如果只允许管理员创建用户,进入 **Authentication → Settings**:

- 关闭 **Allow new users to sign up**
- 改为管理员通过 API 创建用户(用 `service_role key` 调 `auth.admin.createUser`)

## 9. 插入初始系统管理员

项目初始化后,需要手动创建第一个系统管理员:

1. 在 Supabase Auth 中创建用户:**Authentication → Users → Add user**,填邮箱密码,获得 `user.id`
2. 在 SQL Editor 执行:

```sql
INSERT INTO public.platform_users (
    auth_subject,
    login_name,
    display_name,
    email,
    status,
    platform_roles,
    approved_at,
    approved_by
) VALUES (
    '<你的 Supabase Auth user.id>',  -- 替换为第 1 步获得的 user.id
    'admin',
    '系统管理员',
    'admin@example.com',
    'active',
    '{system_admin}',
    now(),
    gen_random_uuid()
);
```

> 初始管理员需在 Supabase Auth 中创建对应认证用户,才能在 Web Console 或 DSH Electron APP 登录。`auth_subject` 填该用户的 `user.id`。

## 10. 各组件连接配置清单

完成上述配置后,各组件按以下方式连接 Supabase。

### 10.1 Node `platform-user-supabase`(enterprise profile,员工端 + 现有)

通过 Supabase API 操作 `public.platform_users` 和 `audit_events`,同时用 Supabase Auth 做注册/登录。配置在 enterprise-app bundle 的 `cordis.patch.yml` 中注入:

```yaml
- id: platform-user-supabase
  name: '@deepseek-ai/dsh-platform-user-supabase'
  config:
    url: '<第 2.1 节 Project URL>'
    serviceRoleKey: '<第 2.1 节 service_role key>'
    anonKey: '<第 2.1 节 anon key>'
    usersTable: 'platform_users'
    auditTable: 'audit_events'
```

通过环境变量注入(`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_ANON_KEY`)更安全,不写入配置文件。

### 10.2 Flowable 引擎(Java Spring Boot,服务器端)

通过 JDBC 直连 Postgres 操作 `flowable` schema(自动建 ACT_* 表),并用 JWT Secret 验证员工请求带的 Supabase JWT。

**application.yml**:

```yaml
spring:
  datasource:
    url: jdbc:postgresql://db.<project-ref>.supabase.co:5432/postgres
    username: postgres
    password: <第 1 节数据库密码>
    driver-class-name: org.postgresql.Driver
  flowable:
    database-schema: flowable
    database-schema-update: true
    # 启动时自动在 flowable schema 建 ACT_* 表
    async-executor-activate: true
    rest-api-enabled: true

# Supabase JWT 验证(自定义 Spring Security filter 用)
dsh:
  supabase:
    jwt-secret: <第 2.3 节 JWT Secret>
```

Flowable 引擎需要实现一个 Spring Security filter,用 `jwt-secret` 验证 `Authorization: Bearer <token>` 中的 Supabase JWT,从 `sub` 字段提取 `user.id`,用于查询 `assignee = user.id` 的任务。Web Console 后端调 Flowable REST 用 service account(部署/管理操作,不代员工)。

### 10.3 Web Console 后端(Java Spring Boot,服务器端)

通过 JDBC 直连 Postgres 操作 `public` schema(治理元数据 CRUD,与 §5 表结构一致),用 Supabase Auth REST API 做管理员登录,用 JWT Secret 验证后续请求。

**application.yml**:

```yaml
spring:
  datasource:
    url: jdbc:postgresql://db.<project-ref>.supabase.co:5432/postgres
    username: postgres
    password: <第 1 节数据库密码>
    driver-class-name: org.postgresql.Driver

dsh:
  supabase:
    url: <第 2.1 节 Project URL>
    anon-key: <第 2.1 节 anon key>
    service-role-key: <第 2.1 节 service_role key>
    jwt-secret: <第 2.3 节 JWT Secret>
  flowable:
    base-url: http://127.0.0.1:<flowable-port>  # 同机部署,调 Flowable REST
    service-account: <Flowable service account credentials>
```

管理员登录流程:Web Console 前端调 Supabase Auth REST API(`POST /auth/v1/token?grant_type=password`,带 `apikey: <anon-key>`)验证密码,拿 JWT → 后续请求带 JWT → Web Console 后端用 `jwt-secret` 本地验证 → 提取 `sub` 作为操作人。

### 10.4 服务器端 DSH(web profile daemon,自动节点执行)

web profile 默认不连 Supabase,只跑自动节点(接收 Flowable 回调,调 LLM/MCP/skill/脚本)。LLM API key 通过 DSH 的 `credentials` 包在服务器端本地管理(`$DSH_HOME/.credentials.yaml` 或进程环境变量)。

**启动命令**(web profile + patch overlay 挂 MCP 和 auto-node endpoint):

```sh
dsh web --profile web --patch ./server-side-overlay.yml
```

`server-side-overlay.yml`(示意,需在 `apps/flowable-engine` 旁配置):

```yaml
- insert:
    - id: mcp-client
      name: '@deepseek-ai/dsh-mcp-client'
      config: { servers: { ... } }
    - id: auto-node-api
      name: '@deepseek-ai/dsh-enterprise-auto-node-api'
      inject: [webServer]
```

web profile 默认 `127.0.0.1:3080`,Flowable 引擎同机部署,通过 loopback 回调 `/api/enterprise/auto-node/execute`。

### 10.5 员工端 DSH Electron APP(enterprise profile,未来)

每个员工 PC 运行 enterprise profile(Electron 壳打包),本地 LLM key + skill + workspace + AI chat。认证通过内置的 `platform-user-api` 路由(直连 Supabase Auth)。查待办/提交通过 `task-api`(新建,包装 Flowable REST,带员工 Supabase JWT)。

环境变量(`$DSH_HOME/.env` 或进程环境):

```sh
SUPABASE_URL=<第 2.1 节 Project URL>
SUPABASE_ANON_KEY=<第 2.1 节 anon key>
SUPABASE_SERVICE_ROLE_KEY=<第 2.1 节 service_role key>
DEEPSEEK_API_KEY=<员工自己的 LLM key,本地管理>
```

## 11. 配置校验清单

完成全部配置后,按此清单验证:

1. Supabase 项目已创建,获得 URL / service_role key / anon key / 数据库密码 / JWT Secret
2. 两个 schema 已创建:`public`(默认,含所有业务表)、`flowable`
3. `public.platform_users` 和 `public.audit_events` 表已建,索引和约束齐全
4. `public` 下 4 张治理表已建,外键和约束齐全
5. 初始系统管理员已插入,`auth_subject` 对应 Supabase Auth 用户
6. Flowable 引擎首次启动后,`flowable` schema 下出现 `ACT_*` 系列表
7. Node enterprise profile 启动后,`/api/enterprise/auth/login` 能登录并返回 JWT
8. Web Console 后端能用 JWT Secret 本地验证 Supabase JWT
9. 服务器端 DSH(web profile)启动后,`127.0.0.1:3080` 可访问
