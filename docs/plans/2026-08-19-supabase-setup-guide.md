# Supabase 配置手册:企业级应用平台

本手册指导你在 Supabase 中完成 DSH 企业级应用平台所需的全部配置,覆盖认证中心、统一存储和各组件连接。

认证与授权设计见 [DSH 企业级应用平台设计文档](2026-08-30-dsh-enterprise-design.md)。本手册仅覆盖 Supabase 初始配置步骤。

## 0. 命名约定

对象字段使用 camelCase(如 `loginName`、`appAdminUserIds`),数据库表使用 snake_case(如 `login_name`、`app_admin_user_ids`)。Java/Node 代码层用 camelCase,通过映射层与数据库 snake_case 互转。本手册 SQL 一律使用 snake_case。

数组类型字段(如 `app_admin_user_ids`、`role_ids`、`visibility_roles`)使用 PostgreSQL 的 `UUID[]` 或 `TEXT[]`,元素为引用对象的 UUID。数组外键约束 PostgreSQL 不原生支持,由应用层校验引用完整性。

## 1. 创建 Supabase 项目

1. 访问 <https://supabase.com>,注册或登录
2. 点击 **New Project**,填写项目名称(如 `dsh-enterprise`)
3. 设置数据库密码,选择区域(建议选离用户最近的区域)
4. 等待项目初始化完成(约 2 分钟)

> 记住数据库密码,Java 组件(Flowable 引擎、Web Console 后端)需要用它直连 Postgres。

## 2. 获取项目凭据

进入 **Project Settings → API**,记录以下信息:

### 2.1 Supabase API 凭据(给 Node 认证和前端直连用)

| 凭据       | 字段名     | 获取方式                                                                                       |
| -------- | ------- | ------------------------------------------------------------------------------------------ |
| Project URL | `url`   | 页面顶部完整地址,形如 `https://<project-ref>.supabase.co`(`.co` 结尾;`<project-ref>` 是约 20 位随机字母数字 ID) |
| anon key | `anonKey` | **Project API keys** 区域 `anon` / `public` 行,点 **Reveal** 复制。前端直连 Supabase Auth(注册/登录)和 Node 端 RLS 自读均需要此 key |

### 2.2 数据库连接信息(给 Java 组件直连 Postgres 用)

进入 **Project Settings → Database**,记录以下信息:

| 凭据       | 用途                                                                                    |
| -------- | ------------------------------------------------------------------------------------- |
| Host     | 直连:`db.<project-ref>.supabase.co`;连接池(Supavisor):`aws-0-<region>.pooler.supabase.com` |
| Port     | 直连 `5432`;连接池 session 模式 `5432`,transaction 模式 `6543`                                 |
| Database | `postgres`                                                                            |
| User     | 直连:`postgres`;连接池:`postgres.<project-ref>`                                            |
| Password | 第 1 步设置的项目数据库密码                                                                       |

**连接方式选择**:

- **连接池 Session 模式(推荐)**:`jdbc:postgresql://aws-0-<region>.pooler.supabase.com:5432/postgres`,user `postgres.<project-ref>`。每会话独占后端连接,支持 DDL(含 Flowable 建表);IPv4 可达。
- **连接池 Transaction 模式**:port `6543`,按事务复用连接,**不支持 DDL / prepared statement**,Flowable 建表不能用。
- **直连(Direct)**:`jdbc:postgresql://db.<project-ref>.supabase.co:5432/postgres`,user `postgres`。部分网络(尤其 IPv4-only)无法解析或无法连通,通常需 IPv6。若直连不可达,改用 Session 模式。

建议 Flowable 引擎和 Web Console 后端都用连接池 Session 模式。

### 2.3 JWT 验证

后端自动通过 JWKS 公钥验证 Supabase JWT，无需获取或配置 JWT Secret。各组件配置中的 `jwt-issuer` 填 `${SUPABASE_URL}/auth/v1`（见第 10 节）。

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

-- 注册 trigger:用户在 Supabase Auth 注册时,自动在 platform_users 插入 pending_approval 记录
-- 前端 signUp 传入的 user_metadata(display_name / login_name)在此读取
CREATE OR REPLACE FUNCTION public.handle_new_platform_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.platform_users (
        auth_subject,
        login_name,
        display_name,
        email,
        status
    ) VALUES (
        NEW.id::text,
        COALESCE(NEW.raw_user_meta_data->>'login_name', NEW.email),
        COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
        NEW.email,
        'pending_approval'
    )
    ON CONFLICT (auth_subject) DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_platform_user();

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

Web Console 后端通过 JDBC 直连操作，与平台用户治理表同在 `public` schema。

```sql
-- 5.1 应用表
CREATE TABLE public.applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    -- 图标 base64 数据 URL(可空;Web Console 后端未传时自动填充默认图标)
    icon TEXT,
    -- 状态:draft / active / suspended / archived(archived 为终态)
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'suspended', 'archived')),
    -- 应用管理员列表,引用 platform_users.id,至少一个
    app_admin_user_ids UUID[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    archived_at TIMESTAMPTZ,
    archived_by UUID
);

CREATE INDEX idx_applications_status ON public.applications (status);
```

SkillHub namespace 列（2026-09-11）：应用绑定 SkillHub 命名空间（应用下流程的 skillRefs 仅可引用该命名空间下已发布 skill）。已建表的环境手工执行：

```sql
ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS skillhub_namespace text;
COMMENT ON COLUMN public.applications.skillhub_namespace IS 'SkillHub 命名空间;应用下流程的 skillRefs 仅可引用该命名空间下已发布 skill';
```

```sql
-- 5.2 应用角色表
-- parent_role_id 指向父角色,上级继承下级权限并可处理下级待办
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

-- 5.3 应用成员表
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
-- 不在企业层维护资源目录;skill/mcp/llm 由 DSH 运行时管理,
-- 节点通过 BPMN extensionElements 的 skillRefs 引用。

-- 5.5 流程定义表
-- 仅存 Flowable 不管的治理元数据 + 草稿 BPMN;版本/节点定义/实例/任务由 Flowable ACT_* 表管理。
-- 节点 DSH 特有元数据(assignmentRule/inputSchema/outputSchema/resourceBindings/timeoutPolicy)
-- 写在 BPMN XML 的 dsh: extensionElements,随 BPMN 单一存储。
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

Flowable 引擎启动时根据配置自动在 `flowable` schema 创建 `ACT_*` 系列表，无需手动建表。配置 `flowable.database-schema=flowable` 和 `flowable.database-schema-update=true` 后，首次启动自动建表。

`postgres` 超级用户自动拥有 `flowable` schema 权限。生产环境用专用角色时，需 `GRANT ALL ON SCHEMA flowable TO <role>;`。

## 7. 配置行级安全(RLS)

### 7.1 起步:启用 RLS + platform_users 自读策略

```sql
-- 启用 RLS(postgres 超级用户自动绕过)
ALTER TABLE public.platform_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

-- platform_users 自读策略:用户只能读 auth_subject = 自己 JWT.sub 的行
CREATE POLICY platform_users_self_read ON public.platform_users
    FOR SELECT TO authenticated
    USING (auth_subject = (auth.jwt() ->> 'sub'));

-- 治理元数据表同样启用 RLS,Java 用 postgres 超级用户绕过
ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_definitions ENABLE ROW LEVEL SECURITY;
```

### 7.2 生产环境:专用角色与策略(可选)

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

专用角色不是超级用户，RLS 会生效。需为每张表配置 RLS 策略允许该角色访问，或给角色 `BYPASSRLS` 属性。

## 8. 配置 Supabase Auth

### 8.1 认证提供方配置

进入 **Authentication → Providers**,按需启用:

| 提供方    | 配置项                            |
| ------ | ------------------------------ |
| Email  | 默认启用,可配置确认邮件模板                 |
| GitHub | OAuth App 的 Client ID / Secret |
| Google | OAuth 2.0 Client ID / Secret   |

### 8.2 关闭公开注册(可选)

如果只允许管理员创建用户,进入 **Authentication → Settings**:

- 关闭 **Allow new users to sign up**
- 改为管理员在 Supabase Dashboard 手动创建用户(**Authentication -> Users -> Add user**)

## 9. 设置初始系统管理员

项目初始化后,需要手动将第一个用户设为系统管理员。注册 trigger 已自动插入 `pending_approval` 行,这里只需更新状态与角色(第一个管理员无人在 UI 审批,走 SQL 引导):

1. 在 Supabase Auth 中创建用户:**Authentication -> Users -> Add user**,填邮箱密码,获得 `user.id`(trigger 自动在 `platform_users` 插入 `pending_approval` 行)
2. 在 SQL Editor 执行(将该行更新为 active + system_admin):

```sql
UPDATE public.platform_users
SET status = 'active',
    platform_roles = '{system_admin}',
    approved_at = now(),
    approved_by = id
WHERE auth_subject = '<你的 Supabase Auth user.id>';
```

> 初始管理员需在 Supabase Auth 中创建对应认证用户,才能在 Web Console 或 DSH Electron APP 登录。`auth_subject` 填该用户的 `user.id`。

## 10. 各组件连接配置清单

完成上述配置后,各组件按以下方式连接 Supabase。

### 10.1 Node `platform-user-supabase`(enterprise profile,员工端)

配置在 enterprise-app bundle 的 `cordis.patch.yml` 中注入:

```yaml
- id: platform-user-supabase
  name: '@deepseek-ai/dsh-platform-user-supabase'
  config:
    url: '<第 2.1 节 Project URL>'
    anonKey: '<第 2.1 节 anon key>'
    usersTable: 'platform_users'

- id: platform-user-api
  name: '@deepseek-ai/dsh-platform-user-api'
  config:
    supabaseUrl: '<第 2.1 节 Project URL>'
    supabaseAnonKey: '<第 2.1 节 anon key>'
```

通过环境变量注入(`SUPABASE_URL`、`SUPABASE_ANON_KEY`)。

### 10.2 Flowable 引擎(Java Spring Boot,服务器端)

**application.yml**(敏感值通过环境变量注入):

```yaml
server:
  port: 8090

spring:
  datasource:
    url: jdbc:postgresql://${SUPABASE_DB_HOST}:5432/postgres
    username: ${SUPABASE_DB_USER}
    password: ${SUPABASE_DB_PASSWORD}
    driver-class-name: org.postgresql.Driver

# Flowable 配置前缀是顶级 flowable.*
flowable:
  database-schema: flowable
  database-schema-update: true
  async-executor-activate: true
  rest-api-enabled: true
  id-generator: false

# Supabase JWT 验证
dsh:
  supabase:
    jwt-issuer: ${SUPABASE_URL}/auth/v1
  # DSH headless 集成:定制 delegate 注入 DshHeadlessClient 时才用到,repo-root 未配置引擎照常启动
  headless:
    node-bin: node
    repo-root: ${DSH_REPO_ROOT:}
    cli-entry: apps/cli/src/bin.ts
    call-timeout-seconds: 300
```

环境变量见 `.env.ps1.example`。`DSH_REPO_ROOT` / `DEEPSEEK_API_KEY` 只在流程含调 `DshHeadlessClient` 的自动节点时需要(headless 的 LLM 调用读它们);纯人工流程不配置也能正常跑。

### 10.3 Web Console 后端(Java Spring Boot,服务器端)

**application.yml**(敏感值通过环境变量注入):

```yaml
server:
  port: 8080

spring:
  datasource:
    url: jdbc:postgresql://${SUPABASE_DB_HOST}:5432/postgres
    username: ${SUPABASE_DB_USER}
    password: ${SUPABASE_DB_PASSWORD}
    driver-class-name: org.postgresql.Driver
  web:
    resources:
      static-locations: classpath:/static/

# Supabase JWT 验证 + Flowable REST 客户端 + SkillHub REST 客户端
dsh:
  supabase:
    jwt-issuer: ${SUPABASE_URL}/auth/v1
  flowable:
    base-url: ${FLOWABLE_BASE_URL}
  # 企业 Skill 仓库(SkillHub);浏览器不直连,后端持只读 token 代理
  skillhub:
    base-url: ${SKILLHUB_BASE_URL:http://127.0.0.1:8095}
    api-token: ${SKILLHUB_API_TOKEN:}
```

环境变量见 `.env.ps1.example`。

### 10.4 服务器端 DSH(web profile)

**启动命令**:

```sh
dsh web --profile web --patch ./server-side-overlay.yml
```

`server-side-overlay.yml`(示意):

```yaml
- insert:
    - id: mcp-client
      name: '@deepseek-ai/dsh-mcp-client'
      config: { servers: { ... } }
    - id: auto-node-api
      name: '@deepseek-ai/dsh-enterprise-auto-node-api'
      inject: [webServer]
```

web profile 默认 `127.0.0.1:3080`，与 Flowable 引擎同机部署。

### 10.5 员工端 DSH Electron APP(enterprise profile)

环境变量(`$DSH_HOME/.env` 或进程环境):

```sh
SUPABASE_URL=<第 2.1 节 Project URL>
SUPABASE_ANON_KEY=<第 2.1 节 anon key>
DEEPSEEK_API_KEY=<员工自己的 LLM key,本地管理>
```

## 11. 配置校验清单

完成全部配置后,按此清单验证:

1. Supabase 项目已创建,获得 URL / anon key / 数据库密码
2. 两个 schema 已创建:`public`(默认,含所有业务表)、`flowable`
3. `public.platform_users` 和 `public.audit_events` 表已建,索引和约束齐全
4. 注册 trigger 已创建:在 Supabase Auth 注册一个测试用户,`platform_users` 自动插入 `pending_approval` 行
5. `public` 下 4 张治理表已建,外键和约束齐全
6. 初始系统管理员已设置为 `active` + `system_admin`,`auth_subject` 对应 Supabase Auth 用户
7. Flowable 引擎首次启动后,`flowable` schema 下出现 `ACT_*` 系列表
8. DSH enterprise profile 启动后,`/api/enterprise/auth/me` 能验证 JWT 并返回用户治理状态
9. Web Console 后端能用 JWKS 本地验证 Supabase JWT
10. 服务器端 DSH(web profile)启动后,`127.0.0.1:3080` 可访问

## 12. 知识库(2026-09-11 增补,web-console 知识库模块配套)

知识库设计见 [2026-09-11-knowledge-base-design.md](2026-09-11-knowledge-base-design.md)。

**文件存在哪里(存储模型,先读这段再看 SQL)**:

- **文件本体(原始字节)存 Supabase Storage,不存数据库字段**。Storage 是 Supabase 内置的对象存储(类似阿里云 OSS / AWS S3),按"桶(bucket)"组织,桶可以理解为存储里的一个顶级目录。每个应用一个专属桶,桶名 `kb-{appId}`。
- 数据库三张表(knowledge_bases / kb_folders / kb_documents)只存**元数据和可检索文本**:`storage_path` 列记录文件在桶里的路径(如 `<文档id>/报价单.pdf`),`text_content` 列只存从文件里抽取出的纯文本(供关键字检索和 AI 阅读),都不是文件本身。
- **桶不需要手工创建**,所以下面的 SQL 里没有建桶语句:应用第一次打开知识库时,web-console 后端自动向 Supabase 的 `storage.buckets` 系统表插入一条桶登记(与治理表同一条 JDBC 直连连接),桶随首个知识库自动出现。

建表 SQL 与 RLS 手工执行,模式同前文。

### 12.1 建表 SQL(public schema,SQL Editor 执行)

三张表只存"元数据 + 抽取文本";文件原始字节全部在 Storage 桶里(见本节开头存储模型说明)。

```sql
-- ============================================================
-- 表1 knowledge_bases:知识库登记表。一个应用有且只有一个知识库。
-- ============================================================
create table if not exists public.knowledge_bases (
  id             uuid primary key default gen_random_uuid(),  -- 知识库 id
  application_id uuid not null unique references public.applications(id) on delete cascade,
                 -- 所属应用;unique 保证一应用一库;应用删除时级联删掉知识库
  name           text not null,        -- 显示名(web-console 后端自动取「{应用名} 知识库」)
  storage_bucket text not null,        -- 该应用专属桶名('kb-{appId}');文件本体就存在这个桶里
  created_at     timestamptz not null default now()
);

-- ============================================================
-- 表2 kb_folders:文件夹。树形结构靠 parent_id 自引用,支持多级目录。
-- ============================================================
create table if not exists public.kb_folders (
  id         uuid primary key default gen_random_uuid(),  -- 文件夹 id
  kb_id      uuid not null references public.knowledge_bases(id) on delete cascade,
             -- 所属知识库
  parent_id  uuid references public.kb_folders(id) on delete cascade,
             -- 父文件夹 id;为 NULL 表示顶层(根)文件夹;删父文件夹会级联删子文件夹
  name       text not null,        -- 文件夹名(同级不能重名,见下方唯一索引)
  path       text not null,        -- 物化路径:根下的文件夹是 '/财务',它的子级是 '/财务/报销';
             -- 把整条祖先链冗余存一份,"列某文件夹下全部文档(含子文件夹)"就不用递归查询了
  created_at timestamptz not null default now()
);

-- ============================================================
-- 表3 kb_documents:文档登记表。文件本体在 Storage 桶里,这张表只是"说明书"。
-- ============================================================
create table if not exists public.kb_documents (
  id           uuid primary key,     -- 文档 id(web-console 后端生成,同时用作桶内路径前缀)
  kb_id        uuid not null references public.knowledge_bases(id) on delete cascade,
               -- 所属知识库
  folder_id    uuid references public.kb_folders(id) on delete cascade,
               -- 所在文件夹;为 NULL 表示在根目录
  name         text not null,        -- 文档名(如 '报价单.pdf',同级不能重名)
  content_type text not null,        -- MIME 类型(如 application/pdf)
  size_bytes   bigint not null,      -- 文件大小(字节)
  storage_path text not null,        -- 文件在桶内的对象路径:'<文档id>/<文档名>';
               -- 上传/下载/删除时,后端按 storage_bucket + storage_path 到 Storage 定位文件本体
  text_content text,                 -- 从文件抽取出的纯文本(pdf/office 用 Tika 抽,图片用 OCR),
               -- 只用于关键字检索和 AI 阅读,不是文件本体;未解析完成时为 NULL
  parse_status text not null default 'pending' check (parse_status in ('pending','ready','failed')),
               -- 解析状态:pending 待解析 / ready 已就绪(可检索) / failed 解析失败
  parse_error  text,                 -- 解析失败原因(仅 failed 时有值)
  uploaded_by  text not null,        -- 上传者(Supabase Auth 的 user.id,即 JWT 的 sub)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()   -- 解析完成回写文本时会刷新
);

-- 索引:按知识库列文件夹树 / 按路径前缀找子树
create index if not exists idx_kb_folders_kb on public.kb_folders (kb_id, path);
-- 索引:按知识库 + 文件夹列文档
create index if not exists idx_kb_documents_kb_folder on public.kb_documents (kb_id, folder_id);

-- 同名唯一:parent_id/folder_id 可空,Postgres 唯一约束视 NULL 互异,用 coalesce 表达式索引
-- (NULL 与 NULL 本来不算重复,coalesce 把 NULL 统一换成全零 uuid 后,"根目录下同名"也能被唯一索引拦住)
create unique index if not exists uk_kb_folders_sibling
  on public.kb_folders (kb_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
create unique index if not exists uk_kb_documents_sibling
  on public.kb_documents (kb_id, coalesce(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

-- 可选:关键字搜索提速(量级上百可不建)
-- ILIKE '%关键词%' 默认走不了普通索引;pg_trgm 把字符串拆成三元组建 GIN 索引后可以。
-- create extension if not exists pg_trgm;
-- create index if not exists idx_kb_documents_trgm on public.kb_documents
--   using gin ((name) gin_trgm_ops, (text_content) gin_trgm_ops);
```

### 12.2 RLS

RLS(Row Level Security,行级安全)= Postgres 按"当前连接的用户是谁"决定他能看到/写入哪些行。Supabase 的 SQL 接口(PostgREST、Storage)都以请求者的用户 JWT 打开连接,`auth.uid()` 即 JWT 里的用户 id——所以即使有人绕过 web-console 直接连 Supabase,也只能看到自己有权限的应用的数据。

**权限口径(与 web-console 后端一致)**:`应用管理员(app_admin_user_ids)` ∪ `应用 active 成员`——管理员可配置知识库(web-console 管理页签,含开通),成员可做内容访问与上传(员工端)。web-console 的文件上传/下载透传用户 JWT,同样过这些策略,所以管理员即使不在成员表里也能读写文件本体。

**为什么用判定函数**:管理员/成员身份存在 `applications`、`app_memberships` 里,而 §7.1 给这些治理表开了 RLS 但**没有给 authenticated 配任何策略**(治理读写有意只走 JDBC 超级用户)——RLS 策略里直接嵌套查它们会一行都拿不到,判定永远失败。所以先把判定收进 `kb_can_access` 函数:函数声明 `SECURITY DEFINER`,内部以属主身份查询、绕过治理表自己的 RLS,知识库四条策略只调函数,不给治理表开读洞。

`kb_*` 表经 PostgREST 对外暴露,启用"管理员 ∪ 成员"可读;写入只走 web-console 后端 JDBC 连接(连接角色为表 owner,不受 RLS 限制,模式同 §7)。**本段先 drop 再建,可重复执行**:

```sql
-- 三张表开启 RLS;Supabase 里不开 RLS 的表默认对 authenticated 全放行,必须逐表显式开启
alter table public.knowledge_bases enable row level security;
alter table public.kb_folders enable row level security;
alter table public.kb_documents enable row level security;

-- 清理旧版策略;幂等:没建过也不报错
drop policy if exists kb_read_member on public.knowledge_bases;
drop policy if exists kb_folders_read_member on public.kb_folders;
drop policy if exists kb_documents_read_member on public.kb_documents;
drop policy if exists kb_objects_member_rw on storage.objects;

-- 权限判定函数:当前 JWT 用户是否「该应用的 active 成员 ∪ 应用管理员」。
-- SECURITY DEFINER:内部查询以函数属主(postgres)身份执行,绕过治理表自身的 RLS;
-- stable:同一条语句内结果不变,不妨碍优化器;anon 不可调用。
create or replace function public.kb_can_access(p_application_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    -- 分支A:active 成员(成员关系 active × 平台账号 active)
    select 1 from app_memberships m
    join platform_users pu on pu.id = m.user_id
    where m.app_id = p_application_id and m.status = 'active'
      and pu.status = 'active' and pu.auth_subject = auth.uid()::text
  ) or exists (
    -- 分支B:应用管理员(app_admin_user_ids 含我的 platform_users.id)
    select 1 from applications a
    join platform_users pu on pu.auth_subject = auth.uid()::text
    where a.id = p_application_id and pu.status = 'active'
      and pu.id = ANY(a.app_admin_user_ids)
  );
$$;

revoke all on function public.kb_can_access(uuid) from public, anon;
grant execute on function public.kb_can_access(uuid) to authenticated;

-- 策略1:知识库表。
create policy kb_read_member on public.knowledge_bases for select to authenticated
using (kb_can_access(application_id));

-- 策略2:文件夹表(经 kb_id 找到知识库,再按其应用判定;嵌套查知识库表自身受策略1约束,同口径)。
create policy kb_folders_read_member on public.kb_folders for select to authenticated
using (
  exists (
    select 1 from knowledge_bases kb
    where kb.id = kb_folders.kb_id and kb_can_access(kb.application_id)
  )
);

-- 策略3:文档表(口径同上)。
create policy kb_documents_read_member on public.kb_documents for select to authenticated
using (
  exists (
    select 1 from knowledge_bases kb
    where kb.id = kb_documents.kb_id and kb_can_access(kb.application_id)
  )
);
```

Storage 桶按应用动态创建,用一条按桶名前缀匹配的通用策略覆盖所有 `kb-*` 桶。**文件本体就在这一层受控**:`storage.objects` 是 Supabase 的对象存储系统表,每行是一个文件对象,`bucket_id` 列即桶名;`for all` + `with check` 表示读和写(上传)都要过同一条判断;桶名前缀 `kb-%` 限定本策略只作用于知识库桶,不影响其他业务的桶:

```sql
-- 先清理旧版;幂等:没建过也不报错
drop policy if exists kb_objects_member_rw on storage.objects;

create policy kb_objects_member_rw on storage.objects for all to authenticated
using (
  bucket_id like 'kb-%' and exists (
    select 1 from knowledge_bases kb
    where kb.storage_bucket = storage.objects.bucket_id
      and kb_can_access(kb.application_id)
  )
)
with check (
  bucket_id like 'kb-%' and exists (
    select 1 from knowledge_bases kb
    where kb.storage_bucket = storage.objects.bucket_id
      and kb_can_access(kb.application_id)
  )
);
```

桶本身不需要预先创建:应用首次开通知识库时,web-console 后端经 JDBC 连接 `INSERT INTO storage.buckets`(同一条直连路径)自动登记桶,无需手工建桶。

### 12.3 OCR(Tesseract traineddata)

tess4j 内置 Windows 原生库,无需安装 Tesseract 本体,只需语言训练数据:

1. 下载 [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) 的 `chi_sim.traineddata` 与 `eng.traineddata`(追求精度可换 [tessdata_best](https://github.com/tesseract-ocr/tessdata_best),best 与 fast 的中文/英文模型在本机均实测可用);注意用仓库内文件的 raw 下载链接,直接右键另存网页存下来的是 HTML 不是数据文件
https://github.com/tesseract-ocr/tessdata_best/raw/main/chi_sim.traineddata
https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata

2. 放入服务器目录(如 `D:\tessdata`)
3. 设置环境变量 `TESSDATA_PATH=D:\tessdata`(见 12.4)

**JDK 版本要求:web-console 必须用 JDK 21+ 运行**(如 `D:\Java21\bin\java.exe -jar dsh-web-console.jar`)。本机实测 JDK 17.0.12 下 tess4j 5.20 的 OCR 在引擎初始化(`TessBaseAPIInit1`)必现 native 段错误(`Invalid memory access`),JDK 21.0.12 完全正常;多开终端时注意 `java` 可能解析到不同 JDK(本机 D:\Java 为 17,D:\Java21 为 21),以启动后日志或进程路径为准。

OCR 中文时控制台打印 `Error opening data file ... chi_sim_vert.traineddata / Failed loading language 'chi_sim_vert'` 是 Tesseract 尝试加载竖排中文伴随模型的无害警告(引擎行为,非配置错误),可忽略;要消除可另行下载 `chi_sim_vert.traineddata` 放入同目录。

### 12.4 Web Console 环境变量增补(§10.3 基础上追加)

```sh
# Supabase Storage 访问(透传用户 JWT 时随附的 apikey 头,取 §2.1 anon key)
SUPABASE_ANON_KEY=<§2.1 anon key>
# OCR 训练数据目录(§12.3;不配则 OCR 失败并标记 parse_status=failed)
TESSDATA_PATH=D:\tessdata
```
