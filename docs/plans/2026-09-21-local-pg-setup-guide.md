# 本地 PostgreSQL 配置手册:企业级应用平台

## 1. 安装 PostgreSQL(Windows)

1. 下载 PostgreSQL 17 或更高版本的 Windows 安装包:<https://www.postgresql.org/download/windows/>(EDB 安装器)
2. 运行安装器,组件保持默认;安装过程中为超级用户 `postgres` 设置密码并记住(后续填入 `SUPABASE_DB_PASSWORD`);端口保持默认 `5432`
3. 验证 psql 可用:安装器默认不把 psql 加入 PATH,用开始菜单的 **SQL Shell (psql)**,或把安装目录的 `bin` 子目录(如 `C:\Program Files\PostgreSQL\17\bin`)加入 PATH 后打开新终端执行:

```powershell
psql -U postgres -c "SELECT version();"
```

能打印版本号即安装成功。

## 2. 建库与用户

- 使用安装时自带的 `postgres` 数据库,无需新建数据库(服务端 Spring 配置连接 `jdbc:postgresql://<host>:5432/postgres`)。
- 用户默认用超级用户 `postgres`(与 `SUPABASE_DB_USER=postgres` 对齐),权限满足建表与 Flowable 自动建表。
- 如需专用用户,用 psql 连接本地实例执行:

```sql
CREATE ROLE dsh_app LOGIN PASSWORD '<密码>';
GRANT CONNECT ON DATABASE postgres TO dsh_app;
-- 允许创建 §3.0 的 flowable schema
GRANT CREATE ON DATABASE postgres TO dsh_app;
-- PostgreSQL 15+ 的 public schema 默认不放行 CREATE,需显式授权
GRANT USAGE, CREATE ON SCHEMA public TO dsh_app;
```

- 专用用户建好后,第 3 节的建表 SQL 与两个服务都以该用户执行(表归其所有,无需再授权)。
- 若建表 SQL 已用 `postgres` 执行、服务改用专用用户,再补执行:

```sql
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO dsh_app;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO dsh_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO dsh_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO dsh_app;
```

## 3. 执行全量建表 SQL

用 psql(或 pgAdmin)连接本地实例,对 `postgres` 库按 3.0 → 3.5 顺序执行以下 SQL。

### 3.0 建 flowable schema

```sql
-- Flowable ACT_* 表的专用 schema;引擎只在 schema 内建表,不自动建 schema
CREATE SCHEMA IF NOT EXISTS flowable;
```

### 3.1 平台用户治理表

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

### 3.2 企业治理元数据表

```sql
-- 应用表
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
    -- SkillHub 命名空间;应用下流程的 skillRefs 仅可引用该命名空间下已发布 skill
    skillhub_namespace TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    archived_at TIMESTAMPTZ,
    archived_by UUID
);

COMMENT ON COLUMN public.applications.skillhub_namespace IS 'SkillHub 命名空间;应用下流程的 skillRefs 仅可引用该命名空间下已发布 skill';

CREATE INDEX idx_applications_status ON public.applications (status);

-- 应用角色表
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

-- 应用成员表
CREATE TABLE public.app_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id UUID NOT NULL REFERENCES public.applications(id),
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

-- 流程定义表
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
    -- 发布后指向 Flowable 的 deployment 与 procdef ID
    published_deployment_id VARCHAR(64),
    published_procdef_id VARCHAR(64),
    -- BPMN 流程定义 key
    bpmn_process_key TEXT,
    -- 发布版 BPMN XML 快照:发布成功时写入,skill 归属聚合只认这份(不解析草稿)
    published_bpmn_xml TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID,
    updated_at TIMESTAMPTZ,
    updated_by UUID
);

CREATE INDEX idx_workflow_definitions_app_id ON public.workflow_definitions (app_id);
CREATE INDEX idx_workflow_definitions_status ON public.workflow_definitions (status);
```

### 3.3 知识库表

```sql
-- ============================================================
-- 表1 knowledge_bases:知识库登记表。一个应用有且只有一个知识库。
-- ============================================================
create table if not exists public.knowledge_bases (
  id             uuid primary key default gen_random_uuid(),  -- 知识库 id
  application_id uuid not null unique references public.applications(id) on delete cascade,
                 -- 所属应用;unique 保证一应用一库;应用删除时级联删掉知识库
  name           text not null,        -- 显示名(web-console 后端自动取「{应用名} 知识库」)
  storage_bucket text not null,        -- Storage 桶名;全部知识库共用公共桶 'kb-documents'(Supabase 侧一次性手工预建),应用间以对象路径 {appId}/ 段隔离
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
-- 表3 kb_documents:文档登记表。文件本体在 Supabase Storage 桶里,这张表是元数据和可检索文本。
-- ============================================================
create table if not exists public.kb_documents (
  id           uuid primary key,     -- 文档 id(web-console 后端生成,用作桶内对象路径中段)
  kb_id        uuid not null references public.knowledge_bases(id) on delete cascade,
               -- 所属知识库
  folder_id    uuid references public.kb_folders(id) on delete cascade,
               -- 所在文件夹;为 NULL 表示在根目录
  name         text not null,        -- 文档名(如 '报价单.pdf',同级不能重名)
  content_type text not null,        -- MIME 类型(如 application/pdf)
  size_bytes   bigint not null,      -- 文件大小(字节)
  storage_path text not null,        -- 文件在公共桶内的对象路径:'{appId}/{docId}/document{ext}'(应用分段隔离;对象名不含用户输入的中文)
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

-- 关键字检索提速与相关性排序:pg_trgm 扩展 + name/text_content 的 GIN trgm 索引。
-- web-console 列文档带 kw 时按 similarity(name/text_content, kw) 相关性降序,
-- 未装扩展时检索直接报错,故扩展与索引必须执行(与本节其他 SQL 一并跑)。
create extension if not exists pg_trgm;
create index if not exists idx_kb_documents_trgm on public.kb_documents
  using gin ((name) gin_trgm_ops, (text_content) gin_trgm_ops);
```

### 3.4 DSH backend profile 注册表

```sql
-- DSH backend profile 实例注册表:按 url 唯一,实例重启/换址都按 url upsert。
-- active 判定 = last_heartbeat_at 在 5 分钟内(注册心跳周期 60s 的冗余),不维护状态列。
CREATE TABLE public.backend_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 实例展示名(设计器下拉显示)
    name TEXT NOT NULL,
    -- 实例对外可达的调用 URL(flowable delegate 按此提交任务)
    url TEXT NOT NULL UNIQUE,
    -- 当前默认 LLM 标签(实例注册时上报,展示用)
    llm_label TEXT,
    -- 工作空间标签(展示用)
    workspace_label TEXT,
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_backend_profiles_url ON public.backend_profiles (url);
```

### 3.5 组织树

```sql
-- ============================================================
-- 组织树:节点=部门,parent_id 自引用构成行政线。
-- head_user_id 是部门负责人,虚拟角色"上一级"等运行时取这一列。
-- ============================================================
CREATE TABLE IF NOT EXISTS public.org_units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 部门名称
    name TEXT NOT NULL,
    -- 父部门 id;NULL=根节点。循环引用由应用层校验(同 app_roles 惯例)
    parent_id UUID REFERENCES public.org_units(id),
    -- 部门负责人,引用 platform_users.id
    head_user_id UUID REFERENCES public.platform_users(id),
    -- 同级排序
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 索引:按父部门列子部门;按负责人反查
CREATE INDEX IF NOT EXISTS idx_org_units_parent ON public.org_units (parent_id);
CREATE INDEX IF NOT EXISTS idx_org_units_head ON public.org_units (head_user_id);

-- 同级同名唯一:parent_id 可空,Postgres 唯一约束视 NULL 互异,
-- 用 coalesce 表达式索引让"根下同名"也能被唯一索引拦住(同 kb_folders 惯例)
CREATE UNIQUE INDEX IF NOT EXISTS uk_org_units_sibling
  ON public.org_units (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

-- ============================================================
-- 员工×部门多对多映射:员工可属 0..N 个部门(兼岗/跨部门任职)。
-- 审批路由成员判定(sameLine/fixedUnit)与发起身份选择都按此表。
-- ============================================================
CREATE TABLE IF NOT EXISTS public.org_unit_members (
    org_unit_id UUID NOT NULL REFERENCES public.org_units(id),
    user_id UUID NOT NULL REFERENCES public.platform_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_unit_id, user_id)
);

-- 索引:按员工反查其全部部门(发起身份选择/超时升级锚点回退)
CREATE INDEX IF NOT EXISTS idx_org_unit_members_user ON public.org_unit_members (user_id);
```

## 分析看板指标表

web-console 定时轮询 flowable-engine `/actuator/metrics` 落库的运维指标采样表:

```sql
CREATE TABLE IF NOT EXISTS public.dsh_metrics_sample (
    id BIGSERIAL PRIMARY KEY,
    metric TEXT NOT NULL,          -- 指标名,如 dsh.flowable.jobs.async;
                                   -- 带 tag 指标形如 dsh.backend.task{outcome=success}
    statistic TEXT NOT NULL,       -- VALUE / COUNT / TOTAL_TIME / MAX
    value DOUBLE PRECISION NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dsh_metrics_sample_metric_ts
  ON public.dsh_metrics_sample (metric, ts DESC);
```

可选(数据量增长后按需执行):引擎历史表按"定义 + 发起时间"聚合查询的组合索引:

```sql
CREATE INDEX IF NOT EXISTS idx_hi_actinst_procdef_start
  ON flowable.act_hi_actinst (proc_def_id_, start_time_);
```