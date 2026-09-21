# DSH Backend Task 与 Backend Profile 设计

日期：2026-09-14
状态：实施完成——4 组代码全部落地（组 1/2 待手工验证；组 3 已过 tsc + 后端单测；组 4 已过引擎全量单测 27/27）；端到端手工验证见 §12

## 1. 定位

DSH backend task 是 BPMN 画布上的独立自动节点：流程走到该节点时，引擎通过 HTTP API 调用服务器上常驻的 DSH backend profile 实例，由其运行一次非交互 AI 会话生成 JSON，直接按输出映射写入流程上下文，全程无人工参与。

一句话：**DSH backend task + backend profile = 服务器端自动运行、不需要人工交互的 user task**。

与 user task 的对照：

| 维度 | user task | DSH backend task |
|---|---|---|
| 画布组件 | user task | 独立 palette 组件（底层 serviceTask） |
| prompt | userPrompt（`{{}}` 插值 + 编辑对话框） | 同款，复用同一对话框与 JSON 骨架 |
| skill | skillRefs + 员工端 daemon 预装 | skillRefs + backend profile 周期同步预装 |
| 办理人 | 候选角色 + 多实例 | 无候选角色；多实例见 §13（loopCardinality + profile 列表） |
| DSH 侧 | 员工端 Electron（enterprise profile）人机对话 | backend profile，API 调用，一次性会话 |
| 输出 | 人工确认 → 映射对话框 → variables Map | JSON 直接按输出映射写入，无确认 |
| 失败重试 | 超时升级 | async job 重试（failedJobRetryTimeCycle） |
| 新增属性 | — | backend profile 调用 URL |

已确认的关键决策：任务交付采用**提交 + 轮询**；画布上是**全新独立组件**（与现有 service task 并列）；输出映射在**引擎 delegate 执行**；skill 同步感知采用**注册表**。

## 2. 端到端链路

```
发布时   设计器保存 DSH backend task（属性含 backendProfileUrl、userPrompt、skillRefs、outputMappings）
         ↓ 发布校验（§4）→ 部署到 flowable-engine，web-console 快照发布版 BPMN XML

运行时   流程实例走到 DSH backend task（async job）
         → DshBackendTaskDelegate：
           1. {{var.path}} 插值（流程上下文取值，object 序列化 JSON 文本）
           2. POST {backendProfileUrl}/api/backend/tasks   { prompt, skillRefs }  → taskId
           3. 轮询 GET {backendProfileUrl}/api/backend/tasks/{taskId}（短请求）
           4. ready → 解析 result JSON → 按 outputMappings 映射 + 声明类型转换 → setVariable
           5. failed / 超时 / JSON 不合法 → 抛异常 → async job 按 retry cycle 重试 → 耗尽走异常边界

backend  POST 任务 → 创建非交互会话（agent loop 单轮跑完）→ 解析最终输出为 JSON
profile   GET 轮询 → 返回 running / ready(result) / failed(error)

常驻     backend profile 启动/周期向 web-console 注册（URL、名称、LLM、工作空间）
         backend profile 周期拉取归属自己的 skillRefs → 预装到工作空间
```

## 3. BPMN 组件（web-console 前端）

### 3.1 moddle 扩展（`src/bpmn/dsh-moddle.ts`）

BPMN 底座是 `bpmn:serviceTask`，存在 `dsh:backendTask` 扩展元素即识别为 DSH backend task：

```xml
<bpmn:serviceTask id="Backend_1" flowable:delegateExpression="${dshBackendTaskDelegate}"
                  flowable:async="true">
  <bpmn:extensionElements>
    <dsh:backendTask backendProfileUrl="http://host:3190"/>
    <dsh:userPrompt text="你当前的角色为… 请以以下的JSON格式进行输出:…"/>
    <dsh:skillRef>invoice-extract</dsh:skillRef>
    <dsh:outputMappings>
      <dsh:mapping source="amount" target="invoiceAmount"/>
    </dsh:outputMappings>
  </bpmn:extensionElements>
</bpmn:serviceTask>
```

新增/修改的描述符类型：

- 新类型 `BackendTask`（allowedIn `bpmn:ServiceTask`）：属性 `backendProfileUrl`（isAttr，单实例形态）+ `backendProfile` 子元素列表（isMany，多实例形态，见 §13）。
- 新类型 `BackendProfile`：属性 `url`（isAttr），列表第 i 行对应第 i 个实例。
- `UserPrompt`、`SkillRef`、`OutputMappings`/`Mapping`、`VotingRule` 的 `allowedIn` 增加 `bpmn:ServiceTask`（结构与 user task 完全一致，`DshPropertiesProvider`/`UserPromptModal` 现有的读写函数直接复用）。

`userPrompt` 存属性不存正文、`skillRef` 存正文、`outputMappings` 容器 + `mapping` 属性——全部沿用 user task 的既有序列化约定（引擎侧 `DshBpmnExtensionParser` 同构解析）。

### 3.2 palette（`src/bpmn/` 新增 palette provider）

参照 `replace-menu-filter.ts` 已有的 `palette.registerProvider` 模式，新增一个 PaletteProvider 追加 entry：

- entry id `create.dsh-backend-task`，独立分组与图标（区别于内置 task/service task）。
- 点击/拖入创建 `bpmn:ServiceTask`，创建时经命令栈一次性写入：
  - `flowable:delegateExpression="${dshBackendTaskDelegate}"`（固定绑定）
  - `flowable:async="true"`（长任务走 async job，事务边界短）
  - `flowable:failedJobRetryTimeCycle` 默认 `R3/PT1M`
  - `dsh:backendTask` 扩展元素（backendProfileUrl 置空，发布校验拦截空值）
- `ReplaceMenuFilterProvider` 的替换菜单处理：DSH backend task 与其他类型互相替换时清理 `dsh:` 扩展元素（实施时对齐现有 user task 替换时的清理策略）。

### 3.3 属性面板（`src/bpmn/DshPropertiesProvider.ts`）

`getGroups` 分发逻辑：`is(element, 'bpmn:ServiceTask')` 且存在 `dsh:backendTask` 扩展 → 渲染 **DSH Backend Task 组**并跳过普通 ServiceTask 的"Flowable 实现方式"组（delegateExpression 已固定绑定，不允许改）。组内 entry：

| entry | 说明 |
|---|---|
| backend profile | 单实例：下拉单选，选项来自 `GET /api/backend-profiles`（active 实例：名称 + URL + LLM 标签）；写入 `dsh:backendTask@backendProfileUrl`。多实例：变为 profile 列表编辑（增删行，每行从同一接口选一个 profile），行数自动同步 `loopCardinality`，见 §13 |
| 失败重试 | 编辑 `flowable:failedJobRetryTimeCycle`（文本 + 格式说明 R*n*/PT*n*M） |
| user prompt | 复用 `userPromptModalEntry`：同一 `UserPromptModal`（prompt 编辑 + 变量选择器 + 输出映射编辑 + JSON 骨架生成 + 插值预览），对 user task 与 backend task 无差别 |
| skill 引用 | 复用现有 `skillRefsEntry`（checkbox 多选，读 `dsh:SkillRef`） |
| 会签计票 | 复用 userTask 的 votingRule 组（表决变量下拉=本节点映射 target），见计票设计 §9 |

## 4. 发布校验（`workflow/BpmnValidationService.java`）

在 `validate` 流程中新增 `validateBackendTasks`：

1. **URL 存在性（强校验）**：每个 `dsh:backendTask@backendProfileUrl` 必须命中注册表中 active（心跳新鲜）的实例；空值报错。
2. **delegate 绑定**：DSH backend task 的 `flowable:delegateExpression` 必须等于 `${dshBackendTaskDelegate}`，`flowable:async` 必须为 true（防止手改 XML 破坏绑定）。
3. **prompt 引用**：`{{}}` 引用存在性与点路径合法——`checkPromptReferences`/`checkFieldPath` 扩展扫描范围到 backend task 的 `dsh:userPrompt`。
4. **输出映射**：target 根变量已声明 + 点路径合法——`checkOutputMappings` 同样扩展扫描范围。
5. **skill 引用**：`validateSkillReferences` 的 skillRef 收集扩展到 backend task（应用绑定的 SkillHub namespace 校验）。

`BpmnContextParser` 增加 backend task 解析辅助（提取 backendProfileUrl + skillRefs），供校验与 §5.4 归属聚合共用。

## 5. 注册表（web-console 后端）

### 5.1 表（Supabase public schema，手工建表，沿用 workflow_definitions 模式）

```sql
CREATE TABLE public.backend_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    llm_label TEXT,
    workspace_label TEXT,
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_backend_profiles_url ON public.backend_profiles (url);
ALTER TABLE public.backend_profiles ENABLE ROW LEVEL SECURITY;
```

`workflow_definitions` 增加一列 `published_bpmn_xml TEXT`（发布时快照发布版 XML；归属聚合只认发布版，草稿不算）。

### 5.2 REST 端点（新 `BackendProfileController`，`/api/backend-profiles`）

| 端点 | 认证 | 说明 |
|---|---|---|
| `POST /register` | permitAll（内网信任） | backend profile 自注册/心跳：`{ url, name, llmLabel, workspaceLabel }`，按 url upsert，刷新 last_heartbeat_at |
| `GET /` | JWT（设计器管理员 `hasAnyRole('SYSTEM_ADMIN','APP_ADMIN')`） | active 实例列表（last_heartbeat_at 5 分钟内），属性面板下拉数据源 |
| `GET /skills?url={url}` | permitAll（内网信任） | 归属该 URL 的 skillRefs 聚合（去重），供 backend profile 周期同步 |

active 判定即心跳新鲜度（5 分钟阈值，注册周期 60s 的冗余），不维护状态列。

### 5.3 认证边界

注册与 skill 拉取端点加入 `SecurityConfig` 的 permitAll 名单——企业服务器内网部署前提下的服务间信任，与已确认的"第一期内网信任"一致；设计器下拉端点走既有 JWT + 角色注解。

### 5.4 归属聚合（新 service）

`BackendProfileSkillService`：查询全部 `status = 'published' and published_bpmn_xml is not null` 的流程定义，解析每份 XML 中指向入参 URL 的 DSH backend task 节点（`BpmnContextParser.parseBackendTasks`：单实例读 `dsh:backendTask@backendProfileUrl` 属性，多实例逐行展开 `dsh:backendProfile` 列表，见 §13.4），聚合其 `dsh:skillRef` 去重返回。

存量已发布流程（本列加之前的）无快照，聚合不到——需重新发布一次（见 §11）。

## 6. 引擎 delegate（flowable-engine）

### 6.1 扩展解析（`listener/DshBpmnExtensionParser.java`）

新增 `parseBackendTask(ServiceTask)`：返回 `{ backendProfileUrl, userPrompt, skillRefs, outputMappings }`（与 user task 同构的解析，复用既有 local name 提取模式；`DshExtensionProperties` 增加 record）。

### 6.2 调用客户端（新 `DshBackendClient`，`@Component`）

HTTP 客户端（`@Component` + Properties record），配置 `dsh.backend.*`（`poll-interval-seconds` 默认 3、`call-timeout-seconds` 默认 600）：

```java
public BackendResult execute(String baseUrl, String prompt, List<String> skillRefs)
```

1. `POST {baseUrl}/api/backend/tasks`，body `{ prompt, skillRefs }` → `202 { taskId }`。
2. 轮询 `GET {baseUrl}/api/backend/tasks/{taskId}`（间隔 poll-interval），累计到 call-timeout 抛 `IllegalStateException`。
3. `ready` → 返回 result JSON；`failed` → 抛异常携带 error 文本。

### 6.3 delegate（新 `DshBackendTaskDelegate` implements `JavaDelegate`，bean 名 `dshBackendTaskDelegate`）

`execute(DelegateExecution)`：

1. 解析本节点扩展属性。
2. 解析本实例的 profile URL：单实例读 `backendProfileUrl` 属性；多实例（执行上有 `loopCounter` 本地变量）取 `dsh:backendProfile` 列表第 i 个（`loopCounter` 从 0 起），列表缺失或越界抛异常（见 §13）。
3. 插值 userPrompt：`{{var.path}}` 从流程上下文取值，object 序列化为 JSON 文本、array 序列化为 JSON 数组文本（与 user task 任务创建时的插值语义一致；实施时定位现有插值实现抽公共）。
4. 调 `DshBackendClient.execute(backendProfileUrl, 插值后 prompt, skillRefs)`。
5. 解析 result JSON（首个 `{` 到末个 `}` 之间的 JSON 提取，防模型输出包了代码块外的说明文字）。
6. 按 outputMappings 执行映射写入：
   - `source` 相对 result JSON 根的点路径取值（空 = 整体），`target` 为上下文变量点路径。
   - 按 `dsh:contextVariables` 声明类型转换（复用从 `DshTaskCompletionService` 抽出的类型转换 + 点路径写入公共逻辑）；**array 为整体覆盖写，不做 user task 多实例的追加聚合**；未声明变量拒绝写入并抛错。

失败（HTTP 不通/超时/failed/JSON 不合法/类型不匹配）一律抛异常，交给 async job 按 `failedJobRetryTimeCycle` 重试；重试耗尽走异常边界事件（未挂边界则流程实例报错，与其他 delegate 失败一致）。

## 7. Backend Profile（DSH 侧）

### 7.1 插件 `packages/enterprise/backend-task/`

函数插件形态（`name`/`inject`/`Config`/`apply`），`inject = ['webServer', 'skills', …]`（会话/agent 能力的注入面实施时按 headless runner 的实际依赖定）。

Config（cordis.yml / env 覆盖，沿用 enterprise 插件模式）：

| 字段 | env | 说明 |
|---|---|---|
| webConsoleBaseUrl | `WEB_CONSOLE_BASE_URL` | 注册与 skill 拉取目标 |
| selfUrl | `DSH_BACKEND_URL` | 对外可达的本实例 URL（注册用） |
| name | `DSH_BACKEND_NAME` | 展示名 |
| syncIntervalMs | — | skill 同步周期，默认 5 分钟 |
| registerIntervalMs | — | 注册心跳周期，默认 60 秒 |

REST（`ctx.webServer.register` prefix `/api/backend/tasks`，沿用 knowledge 插件的路由模式）：

- `POST /api/backend/tasks`：`{ prompt, skillRefs }` → 内存任务表建项 → 并发起一个非交互会话执行 → `202 { taskId }`。
- `GET /api/backend/tasks/{taskId}`：`{ status: 'running' | 'ready' | 'failed', result?, error? }`（ready 时 result 为解析后的 JSON 对象）。

会话执行：每个任务创建一个独立会话——agent 以 prompt 为唯一 user message 跑到轮次结束，最终 assistant 文本按"首个 `{` 到末个 `}`"提取 JSON；skillRefs 指定会话装载的 skill（已由同步 daemon 预装在工作空间）。执行路径复用 headless runner 的 Agent 创建与单轮任务模式（实施时从 `packages/bundle/headless` 的 runner 抽出可编程调用面，而非起子进程）。多任务并发 = 多会话并行；内存任务表进程内生命周期（重启丢任务，调用方按失败重试，可接受）。

skill 同步 daemon：周期 `GET {webConsoleBaseUrl}/api/backend-profiles/skills?url={selfUrl}` → 安装列表到工作空间 skill 目录（复用 skill-sync 插件的 SkillHub 拉取 + `FileSystemSkillProvider` 模式；来源是注册表归属聚合而非 flowable 待办扫描，故为独立 daemon，不复用 skill-sync 插件本体）。

注册 daemon：启动 + 周期 `POST {webConsoleBaseUrl}/api/backend-profiles/register`。

### 7.2 bundle `packages/bundle/enterprise-backend/`

结构参照 `enterprise-app`（`dsh.bundle.patch` + cordis.patch.yml）。bundle 层序：

- `dsh-base`（既有模板层）
- `dsh-enterprise-backend`（新）：insert `webserver`（host/port 经 env）→ `backend-task` → `knowledge`（webConsoleBaseUrl）→ `skillhub` 相关基础插件

与 `enterprise-app` 的区别：**无浏览器 UI 插件**（无 ui-enterprise / client 系列），无 flowable-task-proxy（不处理待办）。工作空间即启动目录（base 层 `workspaceRoot: process.cwd()` 现状，换工作空间 = 换启动目录）。LLM 经 `$DSH_HOME/settings.yaml`（或 env 凭据）既有配置面，`llm_label` 取当前默认模型名注册上报。

### 7.3 profile 模板

`packages/boot/app-boot/src/profile.ts` 的 `PROFILE_TEMPLATES` 增加 `enterprise-backend`：`bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-enterprise-backend']`、`patchReload: 'live'`。沿用 enterprise 模板的既有先例，一处 insert，不动机制与默认行为。启动：`cd <工作空间> && dsh --profile enterprise-backend`。

### 7.4 服务账号（可选项，第二期）

backend task 会话若需知识库工具（kb_search 等），knowledge 插件依赖 `currentUser` JWT；backend profile 无人工登录。第二期加服务账号（Supabase 建服务用户，env 凭据编程登录注入登录态）。第一期 backend task 会话不含知识库工具（bundle 不 insert knowledge 时无此问题；若 insert 则工具调用返回 401 由模型自行绕开——**建议第一期不 insert knowledge**，干净）。

## 8. 失败语义与重试汇总

| 阶段 | 失败 | 处理 |
|---|---|---|
| delegate 提交/轮询 | 连接失败、超时（600s）、profile 返回 failed | 抛异常 → async job 按 retry cycle 重试（重新提交 = 新会话） |
| JSON 解析 | 输出无合法 JSON | 抛异常 → 重试 |
| 映射/类型转换 | target 未声明、类型不匹配 | 抛异常 → 重试 |
| 重试耗尽 | — | 异常边界事件接管；未挂边界则流程实例报错 |

重试次数由节点属性 `failedJobRetryTimeCycle` 控制（属性面板可编辑，默认 `R3/PT1M`）。

## 9. 需要建表 SQL / 配置的运维项

- Supabase 执行 `backend_profiles` 建表 + `workflow_definitions` 加列（补入 supabase-setup-guide 手册）。
- 服务器侧部署 N 个 backend profile 实例：各自工作空间目录、`DSH_BACKEND_URL`/`DSH_BACKEND_NAME`/`WEB_CONSOLE_BASE_URL` env、`DEEPSEEK_API_KEY`。

## 10. 工作项清单

4 组串行实施，组间有明确集成环验证；每组末尾自带测试/验证，不拖到最后。

### 组 1：注册表后端（web-console）

| # | 工作项 | 验证 |
|---|---|---|
| 1 | 建表 SQL + 手册补录：`backend_profiles` 建表 DDL、`workflow_definitions` 加 `published_bpmn_xml` 列；补入 supabase-setup-guide.md | Supabase 执行 DDL，检查表与列存在 |
| 2 | `BackendProfileJdbcRepository` + DTO：upsert（按 url）、listActive（heartbeat 5 分钟内）、listAllPublishedXmls | Repository 单测（insert/upsert/listActive 按过期过滤） |
| 3 | `BackendProfileSkillService`：查询 `status=published AND published_bpmn_xml IS NOT NULL` 的流程定义，解析 XML 中 `dsh:backendTask@backendProfileUrl` 聚合 skillRefs 去重；`BpmnContextParser` 增加 backend task 解析辅助 | XML 字符串单测（含空 URL、无 backend task 边界；published_bpmn_xml 全 NULL 时返回空列表） |
| 4 | `BackendProfileController`：`POST /register`（permitAll upsert）、`GET /`（JWT + `hasAnyRole`）、`GET /skills?url=`（permitAll 调 §3） | curl register → 查库有新行 → curl GET 返回 → curl skills 返回空 |
| 5 | 发布链路快照：`WorkflowDefinitionService.publish` 写入 `published_bpmn_xml` | 发布现有 user task 流程 → 查该列有值且与 XML 一致 |

**组 1 集成验证**：curl register → 查库 → curl list → curl skills（空）。注册表闭环，可被真实 backend profile 喂活。

### 组 2：Backend Profile（DSH 侧）

| # | 工作项 | 验证 |
|---|---|---|
| 6 | `packages/enterprise/backend-task` 插件：REST 端点 + 会话执行（`POST /api/backend/tasks` 建内存任务 → 非交互会话执行；`GET /api/backend/tasks/{taskId}` 返回 running/ready/failed）。从 headless runner 抽可编程调用面（Agent 创建 + 单轮跑完 + 首末花括号间 JSON 提取）。不含 daemon（§7 加） | tsx 直接运行插件 → curl POST → curl GET 轮询 → 拿到 ready + result JSON。此步自包含，不依赖注册表 |
| 7 | 同插件加 daemon：注册 daemon（启动 + 60s 周期 `POST {webConsoleBaseUrl}/api/backend-profiles/register`）、skill 同步 daemon（启动 + 5 分钟周期 `GET .../skills?url=` → 装 skill 到工作空间）。Config 加 webConsoleBaseUrl/selfUrl/name/syncIntervalMs/registerIntervalMs | profile 启动后 60s 内 → curl 组 1 GET `/api/backend-profiles` 看到新实例；skills 返回空 |
| 8 | `packages/bundle/enterprise-backend`（cordis.patch.yml: insert webserver → backend-task，不含 knowledge/UI；package.json 依赖）+ `app-boot/profile.ts` 加 `PROFILE_TEMPLATES.enterprise-backend` | `cd <ws> && dsh --profile enterprise-backend` 启动 → 组 1 注册表看到新实例 |
| 9 | 插件单测：REST 端点任务生命周期（running → ready / failed）、注册 daemon 调端点 mock | vitest 通过 |

**组 2 集成验证**：组 1 注册表 + 组 2 profile 形成第一个可运行集成环——profile 启动即注册进 web-console，skill 同步能拉到归属 skillRefs（还没发布 backend task，返回空正常）。

### 组 3：BPMN 画布组件 + 发布校验（web-console 前端 + 后端）

| # | 工作项 | 验证 |
|---|---|---|
| 10 | moddle 扩展：`BackendTask` 类型（属性 `backendProfileUrl`，allowedIn `bpmn:ServiceTask`）；`UserPrompt`/`SkillRef`/`OutputMappings`/`Mapping` 的 allowedIn 加 `bpmn:ServiceTask` | XML 字符串 moddle parse + serialize 正确 |
| 11 | palette provider：注册 `create.dsh-backend-task` entry。拖入创建 ServiceTask，命令栈一次性写入 `delegateExpression=${dshBackendTaskDelegate}` + `async=true` + `failedJobRetryTimeCycle=R3/PT1M` + `dsh:backendTask backendProfileUrl=""` | 设计器 palette 出现新条目 → 拖入 → inspect 面板四属性正确 |
| 12 | 属性面板：`DshPropertiesProvider` 检测到 ServiceTask 含 `dsh:backendTask` 即渲染 backend 组并跳过普通 ServiceTask 组。组内：profile 下拉（调 `GET /api/backend-profiles` 拿组 2 真实实例）、失败重试文本、user prompt 弹窗入口（复用）、skillRefs checkbox（复用） | 选中 backend task → 四组显示 → profile 下拉选组 2 实例 → inspect 面板 URL 同步 → 开 prompt 弹窗编辑 → 保存 |
| 13 | 替换菜单清理：backend task ↔ 其他类型替换时清理/注入 dsh 扩展 | 替换路径 inspect 面板断言 |
| 14 | 发布校验 `validateBackendTasks`：URL 空值 / URL 注册表存在性（查组 1 listActive）/ delegate 绑定 / async / prompt `{{}}` 引用（扩展 checkPromptReferences）/ 映射 target（扩展 checkOutputMappings）/ skillRefs（扩展 validateSkillReferences） | 设计器配好 backend task（URL 选组 2 实例）→ 发布通过；反面：URL 空 / URL 不存在 / prompt 引用未声明变量 → 报错 |
| 15 | 校验 + moddle 单测 | 后端 BpmnValidationServiceTest 加 backend task 用例；moddle serialize 测试 |

**组 3 集成验证**：组 2 profile 启动 → 设计器 palette 拖入 backend task → profile 下拉选到真实实例 → 配好 prompt + 映射 → 发布通过 → 组 1 注册表归属聚合能拿到这个 backend task 的 skillRefs（发布快照有值了）。

### 组 4：引擎 delegate（flowable-engine）

| # | 工作项 | 验证 |
|---|---|---|
| 16 | `DshBpmnExtensionParser.parseBackendTask(ServiceTask)` + `DshExtensionProperties` 扩展（与 user task 同构解析） | 单测：模拟 Flowable parse 后的 ServiceTask 元素 → 断言解析结果（含边界） |
| 17 | `DshBackendClient`（`@Component`，`dsh.backend.*` 配置）：POST 提交 → 轮询 GET → ready 返回 JSON / failed / 超时抛异常 | 单测：mock HTTP endpoint → 断言轮询逻辑 + 超时 |
| 18 | `DshBackendTaskDelegate`（bean 名 `dshBackendTaskDelegate`）：execute → 解析扩展 → `{{}}` 插值（抽公共自 user task 插值）→ 调 client → 解析 JSON（首末花括号）→ 按 outputMappings 映射 + 类型转换（抽公共自 `DshTaskCompletionService`，array 覆盖写）→ setVariable。失败抛异常走 async job 重试 | 单测：全路径（含失败重试语义） |
| 19 | 端到端集成：部署含 backend task 的流程（组 3 发布通过）→ 触发流程实例 → delegate 提交到组 2 profile → 拿到 JSON → 变量写入 → 流程继续 | Flowable 部署 + REST 触发 + 查变量；反面：profile 挂了 → 实例报错/重试 |

**组 4 集成验证**：完整链路跑通——组 3 发布的流程部署到组 4 引擎 → 触发 → delegate → 组 2 profile → JSON → 变量写入。

### 项目收尾（4 组全部完成后）

- CLAUDE.md 架构段落更新（enterprise 架构图、组件清单）
- Agent Note（非 trivial 改动的设计决策记录）
- e2e 手工清单：注册 → 画布编排 → 发布 → 流程触发 → 后台生成 → 变量写入 → 重试路径

## 11. 边界与后续项

- **不做的**：backend profile 实例间负载均衡（URL 直连，选哪个实例是流程设计决策）；profile 实例的应用归属隔离（注册表全局共享，后续可加 app 绑定）；服务账号登录（§7.4，第二期）；backend task 的 timeoutPolicy/SoD/候选角色（无人工环节，语义不成立；多实例与计票已随 2026-09-15 统一加入，见 §13）。
- **接受的约束**：BPMN 存 URL 本身，profile 换址需改流程重新发布；存量已发布流程需重发布一次才有归属快照；任务表进程内存态，profile 重启丢运行中任务（调用方重试兜底）。
- **后续候选**：服务账号（知识库工具进 backend 会话）、注册表应用绑定、backend task 执行历史入 `dsh/history`（观测运行中/失败的自动节点）。

## 12. 端到端手工验证清单

环境：Supabase + web-console(:8080) + flowable-engine(:8090) + 一个 backend profile 实例。测试流程：开始 → DSH backend task → 结束（三节点）。

### 12.1 准备

1. Supabase 已执行组 1 建表 DDL（`backend_profiles` 表 + `workflow_definitions.published_bpmn_xml` 列）。
2. backend profile 以独立工作空间启动，环境变量：`WEB_CONSOLE_URL`（注册/同步目标）、`DSH_BACKEND_URL`（flowable 引擎能访问到的本实例地址）、`DSH_BACKEND_HOST=0.0.0.0`（分布式监听所有网卡）、`DSH_BACKEND_PORT`、`DSH_BACKEND_NAME`、可选 `SKILL_SYNC_INTERVAL_MS`；LLM 在工作空间 `cordis.patch.yml` 配置第三方 provider。启动：`dsh --profile enterprise-backend --dir <工作空间>`。

### 12.2 正向链路

| # | 步骤 | 预期 |
|---|---|---|
| 1 | 等 60s（或重启 profile），`GET /api/backend-profiles`（web-console） | 列表出现该实例，heartbeat 时间新鲜 |
| 2 | 画布拖入 DSH backend task，属性面板 profile 下拉 | 下拉出现该实例 URL |
| 3 | 声明上下文变量（如 `inputWord` string、`reportSummary` string），编辑 userPrompt 引用 `{{inputWord}}`，配 outputMappings（如 `summary → reportSummary`）、勾选 skill | 配置可保存，XML 检查四属性齐全 |
| 4 | 发布流程 | 发布校验通过；`workflow_definitions.published_bpmn_xml` 有值 |
| 5 | `GET /api/backend-profiles/skills?url=...` | 返回该节点引用的 skill 清单（含 namespace/slug） |
| 6 | 启动流程实例（传 `inputWord`） | 实例创建；backend task 生成 async job |
| 7 | 观察引擎日志 `[DSH backend]` | 提交 → 轮询 → 任务完成日志出现 |
| 8 | 查流程变量（runtime `/process-api/runtime/process-instances/{id}/variables` 或引擎日志） | `reportSummary` 已写入 AI 产出值 |
| 9 | 查实例状态 | 实例已走到结束并完结 |

### 12.3 反向与边界

| # | 场景 | 操作 | 预期 |
|---|---|---|---|
| 1 | profile 挂了 | 杀掉 backend profile 进程后再启动流程实例 | delegate 抛「提交失败」；job 按 `R3/PT1M` 重试；3 次耗尽后实例停在失败节点（无异常边界事件时） |
| 2 | profile 中途恢复 | 反向 1 重试期间重启 profile | 下一次重试提交成功，流程继续走完（验证重试自愈） |
| 3 | 模型输出无合法 JSON | userPrompt 故意要求输出散文 | 任务 failed；引擎日志带 backend error 文本；job 重试 |
| 4 | 轮询超时 | `dsh.backend.call-timeout-seconds` 调小（如 5s）重启引擎再触发 | 超时抛异常走 job 重试 |
| 5 | 发布校验反面 | URL 置空 / 选不存在的 URL / prompt 引用未声明变量 | 发布被拒，错误信息明确 |
| 6 | skill 同步 | 发布带 skillRefs 的流程后等一个同步周期 | profile 工作空间 `.dsh/skills` 出现对应 skill |

## 13. 多实例扩展（2026-09-15 三种任务节点统一）

DSH backend task 支持多实例与单实例，定位是"自动运行的 user task"：与 user task 同样用多实例表达 N 份并行/串行，唯一区别是份数不来自候选角色成员数，而来自设计时显式配置的 `loopCardinality`。三种任务节点的多实例总览见教程第 11 章；普通 ServiceTask 的集合形式与统一计票见计票设计 §9。

### 13.1 模型形态

```xml
<bpmn:serviceTask id="Consult_1" flowable:delegateExpression="${dshBackendTaskDelegate}"
                  flowable:async="true">
  <bpmn:extensionElements>
    <dsh:backendTask>
      <dsh:backendProfile url="http://host-a:3190"/>
      <dsh:backendProfile url="http://host-b:3190"/>
      <dsh:backendProfile url="http://host-c:3190"/>
    </dsh:backendTask>
    <dsh:userPrompt text="…"/>
    <dsh:votingRule variable="approved" passValue="true" passCount="2"/>
  </bpmn:extensionElements>
  <bpmn:multiInstanceLoopCharacteristics isSequential="false">
    <bpmn:loopCardinality>3</bpmn:loopCardinality>
  </bpmn:multiInstanceLoopCharacteristics>
</bpmn:serviceTask>
```

- 实例 i（`loopCounter` 从 0 起）调用列表第 i 个 profile URL——每个实例绑定特定 backend profile（"多 AI 会诊"：3 个不同 LLM 配置各评审一遍）。
- 列表行数必须等于 `loopCardinality`（画布上增删列表行自动同步实例数）。
- 单实例形态（`backendProfileUrl` 属性）与多实例列表互斥，并存被发布校验拒绝。

### 13.2 发布校验（`validateServiceTaskMultiInstance` 的 backend task 分支）

1. `loopCardinality` 必为 >=1 整数。
2. `dsh:backendProfile` 列表非空且行数 = `loopCardinality`。
3. `backendProfileUrl` 属性与多实例列表并存拒绝。
4. 列表 URL 活跃性由 `validateBackendTasks` 逐行查注册表。
5. 标准循环（`standardLoopCharacteristics`）拒绝（与所有任务节点一致）。

### 13.3 引擎 delegate

`DshBackendTaskDelegate` 解析本实例的 profile URL：单实例读属性；多实例按 `loopCounter` 取 `dsh:backendProfile` 列表第 i 个，列表缺失或越界抛异常进 `R3/PT1M` 重试。其余步骤（插值 → 提交轮询 → 输出映射）与单实例完全一致；配了 votingRule 时票源 = 输出映射写入的表决变量，计数走 `DshVotingEndListener`（计票设计 §9.1）。

### 13.4 归属聚合

backend profile 的 skill 归属聚合（§5.4）从已发布 `published_bpmn_xml` 快照解析 `dsh:backendTask`：单实例读 `backendProfileUrl` 属性，多实例遍历 `dsh:backendProfile` 列表逐 URL 归属，两种形态的 skillRefs 都计入对应 profile。
