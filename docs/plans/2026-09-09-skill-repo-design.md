# 企业级 Skill 仓库与自动分发设计（SkillHub + 员工端 skill-sync）

> 目的：为 BPMN user task 的 `dsh:skillRef` 引用建立企业级 skill 的集中管理（发布、版本、审核、分发），并让 DSH 员工端按需自动安装：daemon 周期预装 + 待办打开即时安装，替代手工复制 SKILL.md 到 `%USERPROFILE%\.dsh\skills\` 的现状（[2026-09-05-e2e-demo-design.md](2026-09-05-e2e-demo-design.md) §1.4）。
> SkillHub 的部署与操作手册见 [2026-09-09-skillhub-setup-guide.md](2026-09-09-skillhub-setup-guide.md)（工作项 1 的配套操作文档）。

## 1. 目标与工作项

本设计覆盖四个工作项：

1. **服务器端 skill 仓库**：企业服务器引入 SkillHub 自托管注册中心，集中管理企业级 skill 的上传、更新、删除、版本控制、审核治理与管理界面。
2. **daemon 周期预装**：DSH 员工端后台周期扫描 flowable-engine 中的流程实例与流程定义，解析当前登录用户涉及的 user task（候选角色 + 超时升级目标）所需 skill，提前安装到本地。
3. **待办即时安装**：员工端打开一个待办时，检查该待办 `dsh:skillRef` 是否已安装，未安装则立即安装后再进入 AI 会话。
4. **员工端分发通道**：新增 enterprise profile 的 skill-sync 插件，承载工作项 2/3 的扫描、下载、安装与 skill 注册（DSH 原生不支持 skill 集中管理，此插件是唯一的员工端改动落点）。

## 2. 现状与缺口

### 2.1 DSH 原生 skill 机制（只引用，不改核心）

- skill 格式：`<name>/SKILL.md`（YAML frontmatter：name / description / whenToUse / metadata 等）或扁平 `<name>.md`，由 `packages/skill/skill-filesystem` 扫描目录并注册进 `ctx.skills`。
- 发现路径优先级：项目 `.dsh/skills` → 项目 `.agents/skills` → 自定义目录 → 用户 `~/.dsh/skills` → 用户 `~/.agents/skills`。
- `ctx.skills` 是来源无关注册表：第三方通过 `registerProvider(...)` 注入 skill 源，`snapshot()` / `list()` / `get()` 查询；这正是 skill-sync 插件的接入点。
- 缺口：无远程安装 API；无文件 watcher（目录变化要等重启或 provider 主动失效）；无版本概念、无签名校验。

### 2.2 企业层已有链路

`dsh:skillRef` 全链路已通：设计器 `apps/web-console/frontend/src/bpmn/dsh-moddle.ts` 与 `DshPropertiesProvider.ts` → 引擎解析 `apps/flowable-engine/.../listener/DshBpmnExtensionParser.java`（落 `DshExtensionProperties`）→ 待办 API `apps/flowable-engine/.../api/TaskDto.java` 随 `dshMeta.skillRefs()` 返回员工端。

缺口即本设计的四个工作项：仓库（服务端）、自动分发（daemon + 即时安装）、员工端分发插件、以及 skillRef 的版本语义。

## 3. 方案选型

GitHub 上 DSH skill 生态（dshhub.org 收录 1.3 万插件、dsh-market 1500+、dsh-1024store 1.1 万+）几乎全是员工端安装器或公共社区市场，没有一个同时满足「私有部署 + 上传/更新/删除 + 版本控制 + 审核治理 + 管理界面」。通用 Agent Skills 生态的服务端方案对比：

| 方案 | 许可证 | 企业关键能力 | 结论 |
| --- | --- | --- | --- |
| [SkillHub](https://github.com/iflytek/skillhub)（讯飞） | Apache-2.0 | 语义化版本 + beta/stable 标签 + latest 追踪；团队命名空间（Owner/Admin/Member）；分级审核（团队管理员→平台管理员）+ 审计日志；可见性权限；全文搜索；下载/评分统计；scoped API token；可插拔存储（本地/S3/MinIO）；内置安全扫描器；CLI + REST | **选定**。Spring Boot + React 技术栈与 web-console 同族；Docker Compose 一键部署；迭代活跃 |
| [skilly](https://github.com/scalefocus/skilly) | 开源 | 企业 skill 资产的治理与版本管理 | 定位契合但社区小，备选 |
| [AgentSkills Registry](https://github.com/kai98k/agent-skills-registry) | MIT | Go 单二进制，CLI push/pull/search，semver | 类 npm 模型，无审核治理 |
| [SkillNote](https://github.com/luna-prompts/skillnote) | 开源 | 自托管 SKILL.md 注册中心 + Web 编辑 | 偏轻量团队协作，治理弱 |
| Skilldex（[论文](https://arxiv.org/pdf/2604.16911v1)） | 开源 | Hono + Supabase 注册中心、格式一致性评分 | 与本平台 Supabase 栈同源，可借鉴架构 |

选型理由补充：

- **格式同源**：SkillHub 管理标准 Agent Skills 格式（`SKILL.md` + frontmatter + 配套文件），与 DSH skill 格式一致，DSH 的 skill 目录可直接发布；`anthropics/skills` 生态的 skill 亦可入库复用。
- **员工端实现模式参考**（非依赖）：`dsh-agent-plugins-market` 验证了「`registerProvider` 运行时注入 + 安装后 `invalidate()` 重建目录」的可行性与安全模型（execFile 无 shell、深度 1 克隆、路径逃逸防护）；`dsh-skills-manager` 的 `skills-lock.json` 溯源与更新检测思路可借鉴。注意后者 npm 许可为 UNLICENSED，只能借鉴思路，不能复用代码。

## 4. 总体架构

```
企业服务器（常驻）                                员工 PC（可关机）
┌─────────────────────────────────────┐      ┌──────────────────────────────────────┐
│ web-console (:8080)                 │      │ DSH 员工端（enterprise profile :3080）│
│  BPMN 设计器 skillRefs 下拉          │      │  待办中心 → AI 会话（userPrompt+skill）│
│         │ 拉已发布清单               │      │         │                            │
│ flowable-engine (:8090)             │      │  skill-sync 插件（本设计新增）         │
│  /dsh/tasks/* /dsh/history/*        │◄─────│   ① GET /dsh/skills/required?userId= │
│  /dsh/skills/required（新增）        │◄─────│   ② 下载安装 skill 包                 │
│         │                           │      │   ③ 注入 ctx.skills（registerProvider）│
│ SkillHub (:3000 web / :8095 api)    │      │  本地 skill 缓存 $DSH_HOME/...        │
│  发布/版本/命名空间/审核/扫描         │──────►│                                      │
└─────────────────────────────────────┘      └──────────────────────────────────────┘
```

分发链路四步：

1. 管理员/流程设计者在 SkillHub 发布 skill（版本、可见性、审核）；web-console 的 BPMN 设计器 skillRefs 属性面板改为下拉选择（数据由 web-console 后端代理拉取 SkillHub 已发布清单，浏览器不直连）。
2. 员工端 skill-sync 插件周期调用 flowable-engine 新端点 `GET /dsh/skills/required?userId=`，获得该用户「现在 + 将来」需要的 skill 清单。
3. skill-sync 对比本地缓存，从 SkillHub 下载缺失/过期的 skill 包，写入企业专属缓存目录并失效 skill 目录。
4. 员工打开待办时，skill-sync 检查 `dshMeta.skillRefs()` 对应 skill 是否就绪，缺失则同步走第 3 步后再进入 AI 会话。

skill-sync 运行在 DSH 后台服务进程内（enterprise profile），直接出站访问 SkillHub 与 flowable-engine，不违反「浏览器访问服务器端服务一律经本地 DSH webserver 代理」的原则。

## 5. 工作项 1：SkillHub 仓库

部署与操作细节见 [2026-09-09-skillhub-setup-guide.md](2026-09-09-skillhub-setup-guide.md)，此处只定集成决策：

- **端口**：SkillHub 后端 API 默认 `:8080` 与 web-console 冲突，以源码方式启动时用 `--server.port=8095` 规避；Web UI 保持 `:3000`。平台端口总览更新为：DSH 本地 `:3080`、web-console `:8080`、flowable-engine `:8090`、SkillHub web `:3000`、SkillHub api `:8095`。
- **命名空间规划**：按使用方建命名空间（如 `finance`、`hr`），DEMO 用 `dsh-demo`。skill 可见性用 `namespace-only`（仅命名空间成员可见），不使用 `public`。
- **认证模型**：SkillHub 有独立账号体系（OAuth + API token），不与 Supabase Auth 打通。管理员/流程设计者直接登录 SkillHub Web UI 管理治理；程序化访问一律用 scoped API token（见 §9）。
- **部署形态**：源码部署（fork 上游仓库后定制 logo 与功能），依赖的 PostgreSQL 16 / Redis 独立安装，详见 setup 手册 §4。
- **存储**：内网单机先用默认（本地文件系统，`STORAGE_BASE_PATH` 指定目录）；规模扩大后切 MinIO（`SKILLHUB_STORAGE_PROVIDER=s3`），与现有 Supabase 存储互不干涉。
- **BPMN 设计器集成**：`DshPropertiesProvider.ts` 的 skillRefs 输入改为下拉，选项来自 web-console 后端新增的「已发布 skill 清单」接口（后端持平台 token 调 SkillHub REST，按可见性过滤）。此改动在 web-console 内，属企业定制边界。

## 6. 工作项 2：daemon 周期扫描与预装

### 6.1 flowable-engine 新端点 `GET /dsh/skills/required`

入参：`userId`（Supabase Auth user.id，即流程身份）。出参（建议）：

```json
{
  "skills": [
    { "name": "expense-form-assistant", "version": "latest", "sources": ["active-task", "deployed-definition"] }
  ]
}
```

skill 需求的两个来源：

- **active-task（现在）**：`ACT_RU_TASK` 中 `ASSIGNEE_ = userId` 的活跃待办（多实例已直接指派），取节点 `dsh:skillRef`。经本地 DSH webserver 代理转发，与现有 `/dsh/tasks/*` 一致。
- **deployed-definition（将来）**：静态解析全部已部署流程定义中的 user task——候选角色的成员包含该用户（`assignmentRule.candidateRoleId` → `app_memberships`），以及 `timeoutPolicy` 超时升级目标角色的成员或升级目标用户。串签（sequential）后续节点当前尚无待办，静态解析保证提前预装。

角色→成员解析：flowable-engine 已 JDBC 直连同一 Supabase PG（`flowable` schema），直接跨 schema 查 `public.app_roles` / `public.app_memberships` / `public.platform_users`，不引入新连接。

skillRef 版本语义见 §8；无版本后缀按 `latest`（stable 标签）。

### 6.2 员工端 skill-sync 插件

落点：`packages/enterprise/`（新包，如 `@deepseek-ai/dsh-enterprise-skill-sync`），由 enterprise profile 组合注册。

- **SkillProvider 注入**：`ctx.skills.registerProvider(...)` 注册一个 provider，扫描企业专属缓存目录（建议 `$DSH_HOME/skill-sync/skills/`），pattern 同 skill-filesystem（`<name>/SKILL.md`）。不写入 `~/.dsh/skills`：一是原生 filesystem provider 没有 watcher，装完不生效；二是避免与用户手工管理的 skill 混杂。
- **定时扫描**：配置化间隔（默认 10 分钟，cordis.yml `config` 字段，遵循「无硬编码可调项」约定），调用 `/dsh/skills/required`，diff 本地清单后增量下载。
- **安装与失效**：下载 SkillHub skill 包（zip）解压到缓存目录，写 `.skillhub/metadata.json` 式溯源信息（registry/namespace/slug/version/fingerprint，字段语义与 SkillHub CLI 的 metadata 一致），然后触发 `skills/change` 重建目录——此模式已被 dsh-agent-plugins-market 验证。
- **更新与删除**：清单版本高于本地则升级；流程定义不再引用且缓存 TTL 过期可清理（策略后定，先只装不删，避免误删正在用的 skill）。
- **降级**：registry / token / 间隔 / 缓存目录全部是 `Config` 字段；拉取失败按可重试错误记日志，不阻塞员工端启动。

## 7. 工作项 3：待办打开即时安装

员工端打开待办（已有逻辑：用 `dshMeta` 创建新会话）前插入一步：对 `dshMeta.skillRefs()` 每项查本地缓存，未命中或版本不符则同步调用 skill-sync 的安装路径（同一份代码，daemon 只是周期触发器）。安装完成（或确认已就绪）后才创建 AI 会话，保证会话内 skill 目录完整。安装失败要有可见提示（待办页 toast + 会话首条系统提示），允许用户重试或以无该 skill 的降级体验继续（AI 会话仍可进行，只是 `skill` 工具调不到该技能）。

## 8. skillRef 版本语义扩展

现状 `<dsh:skillRef>` 只有 skill 名。引入仓库后扩展为 `name@version`（version 省略 = latest stable）：

- `dsh-moddle.ts`：属性面板下拉项显示 `name@version`，存入同一属性字符串；校验 `@` 后版本格式（semver 或 `latest`/`beta`/`stable` 标签）。
- `DshBpmnExtensionParser.java` / `DshExtensionProperties.java`：解析时拆分 name 与 version，`skillRefs()` 返回带版本的记录；下游（TaskDto、`/dsh/skills/required`、skill-sync）统一携带。
- 发布校验：skillRefs 引用的 name@version 必须在 SkillHub 已发布清单中存在（web-console 校验器加一条规则，走后端代理查询）。
- 兼容：无 `@` 的旧流程定义按 latest 解析，e2e demo 的 6 个流程无需改动。

## 9. 认证与安全

- **token 分级**：skill-sync daemon 用平台管理员在 SkillHub 签发的只读分发 token（scope 限 search/install/pull，无 publish/delete），配置在 enterprise profile 的 cordis.yml（走 DSH credentials 机制引用，不落明文）；web-console 后端持另一枚读 token 供设计器下拉与发布校验；发布/删除仅管理员在 Web UI 或持写 scope token 的 CLI 操作。
- **网络路径**：员工浏览器不直连 SkillHub；skill-sync 在 DSH 后台服务进程内直连 SkillHub api（`:8095`）与 flowable-engine（`:8090`）。未来若要求员工端也走代理，可由本地 DSH webserver 转发，仅改 skill-sync 的 baseUrl。
- **完整性**：SkillHub 每个版本带 sha256 fingerprint，skill-sync 安装后校验文件哈希再注册（借鉴 SkillHub CLI metadata.json 的 files 哈希清单）。
- **skill 内容安全**：SkillHub 内置 Skill Scanner 多引擎扫描（可关）；上传扩展名白名单默认收窄，企业如需携带脚本（`.py`/`.ps1`）需显式扩 `SKILLHUB_PUBLISH_ALLOWED_FILE_EXTENSIONS` 并评估。
- **许可合规**：`dsh-skills-manager` 为 UNLICENSED，禁止代码复用；`anthropics/skills` 内容转发布遵守各 skill 许可（多为 Apache-2.0，文档类为 source-available）。

## 10. 实施阶段建议

1. **阶段一（工作项 1）**：按 setup 手册部署 SkillHub，建 `dsh-demo` 命名空间，把 e2e demo 的 6 个 skill 发布入库（`skillhub publish`，可见性 `namespace-only`），员工端先用 CLI `--dir` 手动安装跑通「仓库 → 安装 → 待办可用」闭环。
2. **阶段二（工作项 2 前半）**：flowable-engine 实现 `/dsh/skills/required`（先只做 active-task 来源，deployed-definition 静态解析随后）。
3. **阶段三（工作项 2 后半 + 4）**：skill-sync 插件（provider 注入 + 周期扫描 + 下载安装），替换手动 `--dir` 安装。
4. **阶段四（工作项 3）**：待办打开即时安装 + 失败提示。
5. **阶段五**：skillRef 版本语义（§8）与 BPMN 设计器下拉（§5）——可在阶段一后任意时点插入，建议紧跟阶段一以尽早锁定「设计期引用 = 仓库条目」。
