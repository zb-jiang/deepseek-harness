# DSH 企业级应用平台 V1 开发细化 SPEC

## 文档信息

- 文档状态：Final
- 文档日期：2026-08-21（基于 2026-08-19 初稿，整合架构 v5 与 Flowable 引擎实现结论）
- 适用读者：架构师、后端工程师、前端工程师、测试工程师
- 文档目标：把 V1 已形成结论的所有设计细节集中记录，让第三方据此了解完整最新设计，可直接指导代码开发、接口设计、数据建模和测试设计

## 1. 文档定位

本文是 DSH 企业级应用平台 V1 的开发级 SPEC，负责定义开发必须依赖的精确规则，包括整体架构、组件职责、存储设计、对象字段、不变量、状态机、操作语义、流程运行规则、退回规则、管理员干预规则、Flowable 引擎实现细节。

本文不讨论 UI 设计细节和部署运维操作。

## 2. 整体架构 v5

### 2.1 架构图

```
                          ┌───────────────────────┐
                          │   Supabase (云服务)   │
                          │  ┌─────────────────┐  │
                          │  │ Auth: JWT 签发   │  │
                          │  └────────┬────────┘  │
                          │  ┌────────┴────────┐  │
                          │  │ Postgres         │  │
                          │  │ ├─public schema  │  │
                          │  │ │  业务表         │  │
                          │  │ └─flowable schema │  │
                          │  │    ACT_* 表       │  │
                          │  └─────────────────┘  │
                          └───┬───────────────┬───┘
                       JWT 验证│               │JDBC 直连
                               │               │
         ┌─────────────────────┘               └────────────────────┐
         │                                                          │
    ┌────┴──────────────┐              ┌───────────────────────────┴──┐
    │ ① 员工端            │              │ ② Web Console 后台            │
    │ DSH Electron APP    │              │ (独立后台 web 应用)           │
    │                     │              │                               │
    │ ┌─────────────────┐ │              │ ┌─────────────────┐          │
    │ │ UI (浏览器渲染)  │ │              │ │ 前端 (Vue/React)│          │
    │ └────────┬────────┘ │              │ │ - 应用/角色管理  │          │
    │          │          │              │ │ - BPMN 画布     │          │
    │ ┌────────┴────────┐ │              │ │ - 审计/监控     │          │
    │ │ enterprise       │ │              │ └────────┬────────┘          │
    │ │ profile          │ │              │          │                   │
    │ │ (打包在内)       │ │              │ ┌────────┴────────┐          │
    │ │                  │ │              │ │ 后端 (Node/Java) │          │
    │ │ - 代办中心       │ │              │ │ - JWT 验证       │          │
    │ │ - LLM key 本机   │ │              │ │ - 调 Flowable REST│         │
    │ │ - skill 预装     │ │              │ │ - 调 Supabase API│          │
    │ │   定时任务       │ │              │ └────────┬────────┘          │
    │ └────────┬────────┘ │              └──────────┼──────────────────┘
    └──────────┼─────────┘                          │
               │ 获取待办/complete                   │ 部署 BPMN/管理
               │ (REST)                              │ (REST)
               v                                     v
           ┌──────────────────────────────────────────┐
           │ ③ Flowable 引擎 (独立 Spring Boot 服务)   │
           │                                          │
           │ - Flowable REST (/process-api/*)         │
           │ - DSH 薄封装 (/dsh/tasks/*)              │
           │ - DSH 历史审计 (/dsh/history/*)          │
           │ - async-executor (异步 ServiceTask)      │
           │ - DshTaskListener (元数据 + SoD 过滤)     │
           │ - DshExtensionPropertiesCache (缓存)     │
           └──────────────────┬───────────────────────┘
                              │ 自动节点回调
                              │ (ServiceTask delegate)
                              v
           ┌──────────────────────────────────────────┐
           │ ④ 服务器端 DSH web profile (常驻服务)      │
           │                                          │
           │ - web profile (非 enterprise)           │
           │ - 执行自动节点 (LLM + skill + 脚本)      │
           │ - REST endpoint 供 Flowable 回调         │
           └──────────────────────────────────────────┘
```

### 2.2 四大组件职责

| 组件 | 形态 | 职责 |
|------|------|------|
| ① 员工端 DSH Electron APP | 桌面应用（Electron），enterprise profile 打包在内 | 代办中心（按登录 ID 查待办）、LLM API key 本机管理、skill 预装定时任务、点击待办触发新会话注入五要素 |
| ② Web Console 后台 | 独立后台 web 应用，前后端分离 | 应用/角色/成员管理、流程定义草稿编辑、BPMN 画布、审计/监控页面；运行时与 DSH 无关 |
| ③ Flowable 引擎 | 独立 Spring Boot 服务（`apps/flowable-engine/`） | 流程实例推进、节点激活、任务生成、路由、SoD 过滤、异步 ServiceTask、历史审计 |
| ④ 服务器端 DSH web profile | 常驻服务（web profile，非 enterprise） | 自动节点回调入口，执行 LLM 调用 + skill 加载 + 脚本运行，供 Flowable ServiceTask 委托类调用 |

### 2.3 认证模型：直连 Supabase

员工端 DSH Electron APP 和 Web Console 后端都直连 Supabase Auth 完成登录，后端用 Supabase 签发的 JWT 本地验证，不互相做认证中介。

1. Supabase Auth 负责注册、登录、密码、SSO、签发 JWT（HS256）。
2. 员工端 DSH 和 Web Console 后端各自持有 JWT Secret，本地验证 JWT 签名，从 `sub` 字段提取 Supabase Auth 的 `user.id`，无需每次请求都调 Supabase API。
3. Flowable 引擎也持有 JWT Secret，验证员工请求带的 JWT，用于查询 `assignee = user.id` 的任务。
4. Web Console 后端调 Flowable REST 用 service account（部署/管理操作，不代员工）。

### 2.4 数据存储模型：双 schema

| schema | 用途 | 管理方 |
|--------|------|--------|
| `public` | 平台业务表（用户治理、企业治理元数据） | Web Console 后端（JDBC 直连）、Node `platform-user-supabase`（Supabase API）、Flowable 引擎（只读查 `app_memberships` 做 SoD 过滤） |
| `flowable` | Flowable 引擎 `ACT_*` 表（运行时 + 历史） | Flowable 引擎自动建表与管理，其他组件不直接操作 |

### 2.5 服务器端 DSH web profile 的必要性

员工端 DSH 是 Electron APP，下班可能关机；自动节点（ServiceTask）执行时需要回调一个常驻的 DSH 实例。因此在 Flowable 引擎所在服务器上部署一个 DSH web profile（非 enterprise），用于自动节点回调。

- 员工端的 LLM API key 在自己本机管理，不集中管理；员工端 enterprise profile 负责人工节点的 AI chat。
- 服务器端 DSH web profile 负责自动节点的 AI chat，其 LLM API key 由服务器端配置。
- 自动节点执行时，Flowable ServiceTask 委托类通过 REST 调用服务器端 DSH web profile 的 endpoint，触发自动节点执行（LLM 调用 + skill 加载 + 脚本运行）。

## 3. 开发就绪标准

研发可以开始编码的前提，不是"知道系统要做什么"，而是"知道对象如何变化、谁能做什么、什么时候允许做、做完后系统状态变成什么样"。

V1 研发必须以本文定义的以下内容为准：

1. 核心业务对象和必填字段。
2. 每个对象的状态集合和状态迁移规则。
3. 每个用户动作和系统动作的触发条件、结果和审计要求。
4. 流程实例、节点实例、待办和资源之间的绑定关系。
5. 退回、转交、加签、管理员干预等高风险动作的确定语义。

## 4. V1 功能切片

为了让研发能够并行推进，V1 功能拆分为五个开发域。

1. 身份与平台治理域。
2. 应用与角色治理域。
3. 流程定义域。
4. 流程运行域。
5. 审计与运行监控域。

所有代码设计都应能映射到这五个开发域之一，不在这五个域中的能力不纳入 V1。资源目录治理（资源状态、可见/可配/可调用三类权限角色）不纳入 V1，交 DSH 运行时管理。

## 5. 核心对象与必填字段

### 5.1 PlatformUser

`PlatformUser` 表示平台登录主体。

必填字段：

1. `id`
2. `loginName`
3. `displayName`
4. `email`
5. `status`
6. `platformRoles`
7. `createdAt`
8. `createdBy`
9. `approvedAt`
10. `approvedBy`
11. `disabledAt`
12. `disabledBy`

规则：

1. `loginName` 在平台范围内唯一。
2. `platformRoles` 只允许出现 `system_admin`、`app_admin`、`normal_user` 中的一个或多个。
3. 未审批通过的用户不得登录平台。
4. 被禁用或锁定的用户不得处理待办或触发平台动作。

### 5.2 Application

`Application` 表示业务域工作台，是平台一级治理单元。

必填字段：

1. `id`
2. `name`
3. `description`
4. `icon`
5. `status`
6. `workspaceId`
7. `appAdminUserIds`
8. `createdAt`
9. `createdBy`
10. `archivedAt`
11. `archivedBy`

规则：

1. 应用名称在平台范围内可重名，但 `id` 唯一。
2. 每个应用至少有一个应用管理员。
3. 已归档应用不允许新建流程版本和发起新实例。

### 5.3 AppRole

`AppRole` 表示应用内业务角色。

必填字段：

1. `id`
2. `appId`
3. `name`
4. `description`
5. `status`
6. `parentRoleId`
7. `createdAt`
8. `createdBy`

规则：

1. 应用内角色名称唯一。
2. 应用角色只在所属应用内生效。
3. V1 的成员授权只基于角色，不引入部门、组织、岗位维度。
4. `parentRoleId` 为空表示顶级角色；非空时必须指向同一应用内的角色，且不允许形成循环引用。
5. 上级角色自动继承下级角色的全部权限，包括处理下级角色绑定的待办（见 §7.6 角色继承规则）。

### 5.4 AppMembership

`AppMembership` 表示用户在某个应用中的参与关系。

必填字段：

1. `id`
2. `appId`
3. `userId`
4. `roleIds`
5. `status`
6. `grantedAt`
7. `grantedBy`

规则：

1. 同一个用户在同一个应用中只有一条有效成员记录。
2. 一条成员记录可以绑定多个应用角色。
3. 成员状态失效后，该用户不再能访问该应用中的待办和资源。

### 5.5 资源引用（轻量，不建目录表）

V1 不在企业层维护资源目录；`skill`、`mcp`、`llm` 等资源由 DSH 运行时管理。流程节点通过 BPMN extensionElements 的 `skillRefs` 引用所需 skill（见 §5.7），由员工 PC 的 DSH 定时任务预装到本地（见 §10.3），会话中在 `userPrompt` 写明 skill 名称即可加载。

V1 不纳入企业层资源目录治理（资源状态、可见/可配/可调用三类权限角色），该能力交 DSH 运行时。若未来需要企业级资源编目与权限，再引入独立目录表。

### 5.6 WorkflowDefinition

`WorkflowDefinition` 表示流程定义。仅存 Flowable 不管的治理元数据与草稿；流程版本、节点定义、BPMN 内容由 Flowable `ACT_RE_*` 表管理（见 §5.7、§5.8），不重复存储。流程版本（原 `WorkflowVersion`）不再单独建表，映射到 Flowable `ACT_RE_PROCDEF`，DSH 通过 Flowable RepositoryService 访问。

必填字段：

1. `id`
2. `appId`
3. `name`
4. `description`
5. `status`
6. `draftBpmnXml`
7. `publishedDeploymentId`
8. `publishedProcdefId`
9. `createdAt`
10. `createdBy`
11. `updatedAt`
12. `updatedBy`

规则：

1. 流程定义只属于一个应用。
2. V1 只允许草稿编辑；草稿以 `draftBpmnXml` 存储，发布时部署到 Flowable，写入 `publishedDeploymentId` 与 `publishedProcdefId`。
3. 发起流程实例时必须绑定一个已发布版本（Flowable `procdefId`）。
4. `disabled` 和 `archived` 状态都不允许新实例启动。

### 5.7 WorkflowNodeDefinition

`WorkflowNodeDefinition` 表示流程版本中的一个节点。为产品抽象对象，节点定义承载于 BPMN XML；DSH 特有元数据（`assignmentRule`、`inputSchema`、`outputSchema`、`systemPrompt`、`userPrompt`、`skillRefs`、`actionPolicy`）写在 BPMN 的 `dsh:` extensionElements 命名空间，随 BPMN 单一存储，不单独建表。

必填字段：

1. `id`（BPMN 节点 id）
2. `name`
3. `nodeType`
4. `assignmentRule`
5. `inputSchema`
6. `outputSchema`
7. `systemPrompt`
8. `userPrompt`
9. `skillRefs`
10. `actionPolicy`

说明：

1. `nodeType` 只允许 `start`、`human`、`auto`、`condition`、`merge`、`end`。
2. `assignmentRule` 只适用于 `human` 节点，可引用 `app_roles.id` 作为 candidateGroup，按 §7.6 角色继承展开。引用的 `app_roles.id` **必须属于本 BPMN 所属应用**（Web Console 在发布 BPMN 前校验，引擎层不重复校验，见 §12.10 与 §13.4）。
3. `inputSchema` 定义该节点消费的上游字段契约；`outputSchema` 是 JSON Schema，定义该节点提交时必须产出的结构化字段，按 §8.8 校验。
4. `systemPrompt` 为会话级 system prompt（可选，DSH preset section 注入，用户不改）；`userPrompt` 预填会话首条 user message，可含 `{{upstream.field}}` 占位符运行时填充，用户可改并引用 skill 名称。
5. `skillRefs` 声明本节点用到的 skill，供员工 PC 定时任务预装（§10.3）；会话不运行时启用，靠 `userPrompt` 引用已预装 skill 名称加载。
6. `actionPolicy` 定义该节点允许的人工动作和策略，含 `timeoutPolicy`（§7.8）与 SoD 规则（§7.7）。

### 5.8 WorkflowInstance

`WorkflowInstance` 表示某个流程版本的一次真实执行。为产品抽象对象，映射到 Flowable `ACT_RU_EXECUTION`（运行时执行）与 `ACT_HI_PROCINST`（历史实例），不单独建物理表；DSH 通过 Flowable RuntimeService 与 HistoryService 访问。

必填字段：

1. `id`
2. `workflowDefinitionId`
3. `appId`
4. `status`
5. `startUserId`
6. `startedAt`
7. `endedAt`
8. `endReason`
9. `currentEffectiveData`
10. `currentActiveNodeInstanceIds`

规则：

1. 实例一旦创建，其绑定的流程版本不可变。
2. `currentEffectiveData` 表示实例当前有效业务数据快照。
3. 实例处于终态后，不允许再产生新的普通节点实例。

### 5.9 NodeInstance

`NodeInstance` 表示流程实例中的一个节点运行记录。

必填字段：

1. `id`
2. `workflowInstanceId`
3. `nodeDefinitionId`
4. `status`
5. `enterAt`
6. `leaveAt`
7. `inputSnapshot`
8. `outputSnapshot`
9. `resultReason`
10. `retryCount`

说明：

1. `inputSnapshot` 是节点启动时看到的数据快照。
2. `outputSnapshot` 是节点完成时写出的数据快照。
3. `resultReason` 用于标识 `completed`、`returned`、`jumped`、`failed` 等结果原因。

### 5.10 Task

`Task` 表示人工节点分配给人的工作单元。为产品抽象对象，映射到 Flowable `ACT_RU_TASK`（运行时任务）与 `ACT_HI_TASKINST`（历史任务）；SPEC 的扩展状态（`saved`、`transferred`）通过 Flowable 任务变量与认领/重派实现，不单独建物理表。一个待办对应一个 DSH 会话：用户点击待办后，`task-api` 创建新会话并注入节点五要素（`systemPrompt`、`userPrompt`、`inputSchema`、`outputSchema`、`skillRefs`），用户在会话中与 AI 协作处理，点"完成"后校验通过则 complete 任务、会话随之结束；会签、串签的每个处理人在各自 PC 上独立会话。

必填字段：

1. `id`
2. `workflowInstanceId`
3. `nodeInstanceId`
4. `taskStrategy`
5. `assigneeUserId`
6. `status`
7. `createdAt`
8. `startedAt`
9. `submittedAt`
10. `closedAt`
11. `inputSnapshot`
12. `resultSnapshot`

`status` 只允许：

1. `pending`
2. `in_progress`
3. `saved`
4. `submitted`
5. `transferred`
6. `closed`

规则：

1. 一个 `Task` 只绑定一个最终处理人。
2. `transferred` 表示该任务已被转交，原任务不再可处理。
3. `closed` 表示由于退回、跳转、终止等原因被系统关闭。

### 5.11 AuditEvent

`AuditEvent` 表示关键操作的审计记录。

必填字段：

1. `id`
2. `eventType`
3. `operatorUserId`
4. `targetType`
5. `targetId`
6. `workflowInstanceId`
7. `payload`
8. `createdAt`

规则：

1. 所有改变状态的管理动作必须产生审计事件。
2. 审计事件不可修改，只能追加。

## 6. 状态机定义

### 6.1 PlatformUser 状态机

状态集合：

1. `pending_approval`
2. `active`
3. `disabled`
4. `locked`

迁移规则：

1. 注册后进入 `pending_approval`。
2. 审批通过后进入 `active`。
3. 管理员禁用后进入 `disabled`。
4. 系统安全策略触发时进入 `locked`。
5. `disabled` 和 `locked` 都可由系统管理员恢复到 `active`。

### 6.2 Application 状态机

状态集合：

1. `draft`
2. `active`
3. `suspended`
4. `archived`

迁移规则：

1. 新应用创建后进入 `draft`。
2. 配置完成后可进入 `active`。
3. 运行中应用可被停用为 `suspended`。
4. 不再使用的应用可进入 `archived`。
5. `archived` 为终态。

### 6.3 WorkflowDefinition 状态机

状态集合：

1. `draft`
2. `published`
3. `disabled`
4. `archived`

迁移规则：

1. 新流程定义进入 `draft`。
2. 草稿通过校验后可发布为 `published`。
3. 已发布流程可停用为 `disabled`。
4. 不再使用的流程可进入 `archived`。
5. `disabled` 和 `archived` 流程都不允许新实例启动。
6. `archived` 为终态。

### 6.4 WorkflowInstance 状态机

状态集合：

1. `running`
2. `completed`
3. `terminated`
4. `exception`
5. `suspended`

迁移规则：

1. 发起实例后进入 `running`。
2. 到达结束节点并完成后进入 `completed`。
3. 管理员终止后进入 `terminated`。
4. 自动节点失败且未自动恢复时进入 `exception`。
5. 管理员挂起后进入 `suspended`。
6. `completed` 和 `terminated` 为终态。

### 6.5 NodeInstance 状态机

状态集合：

1. `not_started`
2. `in_progress`
3. `completed`
4. `returned`
5. `skipped`
6. `exception`

迁移规则：

1. 节点被激活后从 `not_started` 进入 `in_progress`。
2. 正常完成后进入 `completed`。
3. 当前节点执行退回动作后进入 `returned`。
4. 因条件未命中、管理员跳转或上游退回失效时进入 `skipped`。
5. 自动节点失败后进入 `exception`。

### 6.6 Task 状态机

状态集合：

1. `pending`
2. `in_progress`
3. `saved`
4. `submitted`
5. `transferred`
6. `closed`

迁移规则：

1. 任务创建后进入 `pending`。
2. 用户开始处理后进入 `in_progress`。
3. 用户暂存后进入 `saved`。
4. 用户提交后进入 `submitted`。
5. 用户转交后原任务进入 `transferred`，系统新建一个新的 `pending` 任务。
6. 因退回、跳转、终止等动作导致任务不再有效时进入 `closed`。

## 7. 人工节点策略定义

### 7.1 单人处理

默认人工节点策略是单人处理。

系统根据节点责任规则解析出一个处理人，只生成一个任务。

任务提交后，节点即完成。

### 7.2 会签

`会签` 表示一个人工节点同时分配给多个处理人并行处理。

V1 定义：

1. 节点激活时一次性生成多个并行任务。
2. 所有任务都提交后，节点才完成。
3. 节点输出为全部任务结果的聚合数组。
4. 路由规则读取聚合结果，不读取任一单个任务作为默认最终结论。

V1 不提供"多数通过""一票否决"这类内置审批算法。若业务需要，必须在节点输出契约和路由规则中显式定义。

### 7.3 串签

`串签` 表示一个人工节点由多个处理人按既定顺序依次处理。

V1 定义：

1. 节点激活时只创建第一个处理人的任务。
2. 当前任务提交后，系统创建下一个处理人的任务。
3. 最后一个任务提交后，节点才完成。
4. 每个处理人的结果都被保留，节点输出为按顺序排列的结果数组。

### 7.4 转交

`转交` 表示当前任务处理人将任务处理权移交给另一个用户。

V1 定义：

1. 转交只能发生在任务提交前。
2. 转交后原任务状态变为 `transferred`。
3. 系统新建一条新的 `pending` 任务给目标用户。
4. 新任务继承原任务的输入快照和节点上下文。
5. 转交不改变节点策略，只改变当前处理人。

转交目标用户必须满足该节点的处理权限要求。

### 7.5 加签

`加签` 表示在当前人工节点完成前追加额外处理人。

V1 只支持串行加签，不支持并行加签和前加签。

V1 定义：

1. 当前任务处理人或应用管理员可以发起加签。
2. 加签后，系统在当前处理链后面插入一个新的处理人。
3. 当前处理人提交后，新增处理人的任务被创建。
4. 新增处理人提交后，原处理链继续。
5. 节点完成条件随处理链长度动态变化。

这样设计的目标是降低状态机复杂度，同时满足企业最常见的加签诉求。

### 7.6 角色继承

V1 支持应用内角色树状继承（RBAC1 受限继承）。

定义：

1. 角色通过 `parentRoleId` 形成树状层级，每个角色最多一个父角色。
2. 上级角色自动继承下级角色的全部权限，包括可见资源和可处理待办。
3. 一个用户的有效角色集合等于其直接授予的角色并上这些角色的所有下级角色（递归展开）。
4. 查询用户待办时，系统按有效角色集合匹配节点的责任角色，上级用户可看到并认领下级角色的候选任务。
5. 上级认领下级任务后，任务 `assignee` 设为该上级用户，流程按原节点定义正常流转。
6. 角色继承只在所属应用内生效，不允许跨应用继承。

不变量：

1. 角色层级不形成循环引用。
2. 继承不改变节点定义的责任角色绑定，只扩展用户的可见任务范围。

#### 7.6.1 实现细节（DSH task-api 层展开，引擎层不展开）

V1 角色继承展开在 DSH enterprise profile 的 task-api 层实现，Flowable 引擎层不参与（保持引擎对业务角色语义零耦合）：

1. **引擎层职责**：BPMN userTask 通过 `flowable:candidateGroups=role_id` 存储候选角色 id；task create 时引擎不展开继承，task.candidateGroup 字段存原始 role_id。

2. **task-api 层职责**：DSH task-api 在查询用户待办时：
   - 调 Supabase REST 或直连 PG 查 `public.app_memberships`（按 user_id）拿该用户直接授予的 role_ids。
   - 递归查 `public.app_roles.parent_role_id` 拿所有下级 role_id，组成有效角色集（直接 + 所有下级）。
   - 调 Flowable REST `/process-api/runtime/tasks?taskCandidateGroupIn=<有效角色集>` 查候选 task。

3. **认领时**：上级用户认领下级 task 后，task.assignee 设为该上级 user.id，流程正常流转；引擎层不感知角色继承。

4. **缓存策略**：角色继承展开结果可由 task-api 短期缓存（如 5 分钟）减少 Supabase 查询；用户角色变化后等缓存过期生效。

### 7.7 职责分离

V1 支持运行时职责分离（SoD）校验，防止不相容职务由同一人承担。

校验时机：

1. 用户认领任务（开始处理）前。
2. 用户提交任务前。

V1 校验规则：

1. 审批类节点的处理人不得与流程发起人（`startUserId`）为同一人（`not-applicant`）。
2. 同一实例中，同一用户不得在两个互斥节点（如申请节点与审批节点）都担任处理人（`mutex-node`）。
3. 会签节点的各参与者不得重复，同一用户在同一会签节点只能持有一个任务（`countersign-distinct`，V2 引擎层补，V1 仅 task-api 兜底）。

校验失败时，系统拒绝动作并返回可读说明（如"审批人不得为申请人"），不改变任务状态。校验结果记录审计事件。角色级互斥配置（如"会计与审计员不可兼任"）V2 再纳入，V1 不存储互斥配置。

#### 7.7.1 实现细节（引擎层 vs task-api 层职责边界）

V1 SoD 在两层协作实现，职责清晰：

1. **引擎层（Flowable 引擎，create 时过滤候选）**：
   - `DshTaskListener` 在 task create 事件触发时，解析节点 `dsh:actionPolicy.sodRules`。
   - 若非空，取初始候选 users（优先 BPMN 显式配的 `flowable:candidateUsers`，否则用 `dsh:assignmentRule.candidateRoleId` 或 BPMN `candidateGroups` 查 `public.app_memberships` 拿该 role 下的直接 users）。
   - 调 `DshSodFilter` 应用规则过滤（V1 实现 `not-applicant` + `mutex-node`；`countersign-distinct` V2 deferred）。
   - 把过滤后的 candidates 加入 `task.candidateUsers`（`taskService.addCandidateUser`），并标记 `dsh_sod_applied=true`。
   - 引擎层只看直接 role，不展开角色继承（§7.6 角色继承由 DSH task-api 在查询时做，见 §7.6.1）。

2. **task-api 层（DSH enterprise profile，complete 时兜底校验）**：
   - 用户点"完成"提交 task 前，task-api 的 complete 端点再次校验当前处理人是否违反 SoD（应对 create 后候选 users 变化、手动改 assignee 等场景）。
   - 违反则拒绝 complete，返回可读说明，不改变 task 状态。

3. **SoD 规则类型与 V1 支持矩阵**：

   | 规则类型 | V1 引擎层 | V1 task-api 层 | 说明 |
   |---------|----------|---------------|------|
   | `not-applicant` | ✓ 过滤 | ✓ 兜底 | 从实例变量 `dsh_applicant_user_id` 拿申请人 |
   | `mutex-node` | ✓ 过滤 | ✓ 兜底 | 查同实例其他节点 `.finished()` historic task 的 assignee |
   | `countersign-distinct` | ✗ V2 | ✓ 兜底 | V1 multi-instance 已处理人查询复杂，引擎层 V2 补 |

4. **`not-applicant` 的申请人来源**：流程发起方（Web Console 或员工 DSH）在 start 流程实例时，把发起人 user.id 写入实例变量 `dsh_applicant_user_id`；DshTaskListener 在 create 时读取此变量应用 `not-applicant` 规则。

### 7.8 超时升级

V1 支持人工节点的超时升级（Escalation），基于流程定义中的定时器边界事件配置。

定义：

1. 人工节点可配置超时时长（如 24 小时）和升级目标（上级角色或指定用户）。
2. 超时未处理时，系统自动将任务升级：原任务置为 `closed`，原因标记为 `timeout_escalation`；系统为升级目标用户新建 `pending` 任务。
3. 升级目标若为角色，按 §7.6 角色继承解析为该角色的有效处理人候选集合。
4. 升级动作记录审计事件，并通知原任务处理人。
5. 升级后的新任务继承原任务的输入快照和节点上下文。

配置位置：

1. 流程发布时，节点定义的 `actionPolicy` 包含 `timeoutPolicy`（超时时长与升级目标）。
2. 引擎按 `timeoutPolicy` 生成定时器边界事件，到时触发升级动作。

#### 7.8.1 实现细节（BPMN timer boundary event，引擎层零改动）

V1 超时升级用 Flowable 原生 BPMN timer boundary event 实现，引擎层不写自定义 Job：

1. **BPMN 结构（Web Console 在生成 BPMN 时自动产出）**：
   ```xml
   <userTask id="approveTask" flowable:candidateGroups="role-approver">
     <extensionElements>
       <dsh:actionPolicy>
         <dsh:timeoutPolicy duration="PT24H" escalateToRoleId="role-manager"/>
       </dsh:actionPolicy>
       <!-- 其他 dsh: 元素 ... -->
     </extensionElements>
   </userTask>

   <!-- 非中断式边界定时器:cancelActivity=false,触发后不取消原 task,只是新增升级路径 -->
   <boundaryEvent id="approveTimeout" attachedToRef="approveTask" cancelActivity="false">
     <timerEventDefinition>
       <timeDuration>${dsh_timeout_duration_approveTask}</timeDuration>
     </timerEventDefinition>
   </boundaryEvent>

   <sequenceFlow sourceRef="approveTimeout" targetRef="escalateTask"/>

   <userTask id="escalateTask" flowable:candidateGroups="role-manager">
     <extensionElements>
       <dsh:assignmentRule candidateRoleId="role-manager" taskStrategy="single"/>
       <!-- 继承原节点 systemPrompt/userPrompt/inputSchema/outputSchema/skillRefs ... -->
     </extensionElements>
   </userTask>
   <sequenceFlow sourceRef="escalateTask" targetRef="nextAfterEscalate"/>
   ```

2. **duration 来源**：Web Console 在生成 BPMN 时把 `dsh:actionPolicy.timeoutPolicy.duration`（如 `PT24H`）直接写入 `timerEventDefinition/timeDuration`（或用流程变量 `${dsh_timeout_duration_<nodeId>}` 在 start 时传值）。

3. **升级目标为角色时**：Web Console 在生成 BPMN 时把 `escalateToRoleId` 直接作为 `escalateTask` 的 `flowable:candidateGroups`，候选 users 的角色继承展开由 §7.6.1 DSH task-api 层做。

4. **升级目标为指定用户时**：Web Console 把 `escalateToUserId` 作为 `escalateTask` 的 `flowable:assignee`。

5. **cancelActivity 选择**：
   - `false`（非中断式）：原 task 保留，升级 task 并存；用户可在原 task 或升级 task 任一处理即视为完成。V1 默认用此模式，避免原任务被强制关闭。
   - `true`（中断式）：原 task 取消，仅升级 task；适合"超时即移交给上级"场景。Web Console 可按节点配置选择。

6. **引擎层职责**：零改动；timer 触发、cancelActivity、escalateTask 自动 create 全部由 Flowable 原生处理。`DshBpmnParseHandler` 会为 `escalateTask`（也是 UserTask）自动注入 `DshTaskListener`，同样解析其 dsh 元数据注入 task 变量。

### 7.9 委托代理

V1 支持单 task 手动委托代理（Delegation），允许当前处理人临时把任务转交他人代为处理。

定义：

1. 处理人 A 调用 task-api 的委托端点，指定代办人 B，task 进入 `pending_delegation` 状态。
2. task-api 调 Flowable 原生 `taskService.delegateTask(taskId, B)`：task 的 `delegationState=PENDING`，`owner=A`，`assignee=B`。
3. B 在 task-api 查询时，`my-tasks` 同时包含 `assignee=B` 与 `owner=A && delegationState=PENDING` 两类（即原本属于自己的 task 加上委托给自己的 task）。
4. B 完成处理后调 `taskService.resolveTask(taskId)`：task 回到 owner=A 的 `assignee`，由 A 最终确认 `complete`；或 B 直接 `complete` 由 task-api 接管（V1 简化为 B 完成即视为完成）。
5. 委托记录审计事件，包含 A、B、task、时间。

#### 7.9.1 实现细节（Flowable 原生 delegation，引擎层零改动）

V1 委托代理完全用 Flowable 原生 `taskService.delegateTask` / `resolveTask`，引擎层零代码改动：

1. **委托端点**：直接调 Flowable 自带 REST `/process-api/runtime/tasks/{taskId}` 的 `delegation` action，或 DSH task-api 薄封装 `POST /dsh/tasks/{taskId}/delegate` 转发。

2. **查询语义**：Flowable 的 `taskAssignee(B)` 查询返回 `assignee=B` 的 task；包含 `delegationState=PENDING && assignee=B`（被委托给 B 的）。V1 my-tasks 用此查询即可覆盖两类。

3. **resolve vs complete 选择**：
   - V1 简化：B 直接 `complete` 任务即视为完成；不强制 A 再 resolve 确认。
   - V2 可选：B `resolve` 回交 A，A 再 `complete`；适合 A 需复核 B 工作的场景。

4. **批量委托规则 V2 再纳入**：V1 不支持"未来所有 task 自动委托给 B"的规则配置，仅支持单 task 手动委托。

## 8. 人工节点动作语义

### 8.1 开始处理

触发条件：

1. 任务状态为 `pending` 或 `saved`。
2. 当前用户是任务处理人。

结果：

1. 任务状态进入 `in_progress`。
2. 记录开始处理时间。

### 8.2 暂存

触发条件：

1. 任务状态为 `in_progress`。
2. 当前用户是任务处理人。

结果：

1. 任务状态进入 `saved`。
2. 保存当前临时结果，不触发节点流转。

### 8.3 提交

触发条件：

1. 任务状态为 `in_progress` 或 `saved`。
2. 当前用户是任务处理人。
3. 当前输出通过节点输出契约校验。

结果：

1. 任务状态进入 `submitted`。
2. 写入 `resultSnapshot`。
3. 根据节点策略决定是否完成节点或创建后续任务。

### 8.4 退回

触发条件：

1. 当前节点为人工节点。
2. 当前用户是该节点有效任务的处理人，或具备管理员干预权限。
3. 目标节点必须是当前实例中已经执行过的历史节点。

结果：

1. 当前节点实例状态进入 `returned`。
2. 当前实例的有效数据快照被带回目标节点。
3. 目标节点重新生成新的节点实例和任务。
4. 目标节点之后的当前活跃路径节点实例全部置为 `skipped`，原因标记为 `returned_invalidated`。
5. 所有因此失效的活动任务全部置为 `closed`。

### 8.5 转交

触发条件：

1. 当前任务状态为 `pending`、`in_progress` 或 `saved`。
2. 当前用户是任务处理人。
3. 目标用户满足该节点的处理权限要求。

结果：

1. 当前任务状态进入 `transferred`。
2. 系统新建一条新的 `pending` 任务给目标用户。
3. 新任务继承当前任务的输入快照和节点上下文。
4. 转交动作不改变节点实例状态。

### 8.6 加签

触发条件：

1. 当前节点为人工节点。
2. 当前节点策略允许加签。
3. 当前用户是当前任务处理人，或具备管理员干预权限。
4. 被加签用户满足该节点处理权限要求。

结果：

1. 当前节点的处理链被追加一个新的处理人。
2. 若当前处理人尚未提交，则加签目标在当前处理人提交后获得任务。
3. 节点完成条件按更新后的处理链重新计算。
4. 加签动作必须记录审计事件。

### 8.7 请求补充信息

触发条件：

1. 当前用户是有效任务处理人。
2. 当前任务状态为 `in_progress` 或 `saved`。

结果：

1. 任务保持原状态。
2. 生成一条补充信息请求记录。
3. 不触发流程流转。

### 8.8 输出校验（方案 C）

人工节点提交时，系统按 `outputSchema` 校验 AI 协作产出是否达到下游可消费的最低要求。

校验流程：

1. 用户点"完成"后，`task-api` 的 complete 端点从会话最新 AI message 提取 JSON 代码块（语言标记为 json 的 fenced code block），`JSON.parse` 解析。
2. 用 JSON Schema 校验器（ajv）按节点 `outputSchema` 校验该 JSON。
3. 校验通过：`Flowable TaskService.complete(taskId, { output: json, notes: 自然语言说明 })`，JSON 作为 task output variable 供下游节点消费，流程流转。
4. 校验不通过：将缺项清单作为新一轮 user message 回喂会话（如"系统检测到缺少审批结论字段，请补充"），AI 自动补全后用户再次点完成，形成自动修复闭环；不 complete 任务。

说明：

1. `outputSchema` 为 JSON Schema，定义必须产出的结构化字段。
2. `userPrompt` 引导 AI 在回复中以 JSON fenced code block 输出符合 `outputSchema` 的最终结论，可附自然语言说明。
3. 校验反馈须可读（如"缺少审批结论字段""金额不是数字"），不返回抽象错误代码。
4. 自然语言说明作为附加上下文随 task output 一并保存，供下游参考。

## 9. 退回规则

V1 的退回规则采用"历史保留、当前数据带回、下游实例失效"的模型。

### 9.1 允许范围

1. 只允许退回到当前实例中已经执行过的历史节点。
2. 不允许退回到从未执行过的未来节点。
3. 退回到未来节点属于管理员跳转，不属于退回。

### 9.2 数据规则

1. 系统不删除任何历史节点输出。
2. 当前实例的 `currentEffectiveData` 在退回时作为目标节点的新输入基线。
3. 系统在目标节点输入中额外附加退回原因、退回来源节点和退回时间。
4. 被退回前的后续节点输出保留为历史，但不再参与当前有效路径的数据计算。

### 9.3 历史规则

1. 历史节点实例和任务记录全部保留。
2. 因退回失效的后续节点实例统一标记为 `skipped`。
3. 因退回失效的后续任务统一标记为 `closed`。

### 9.4 审计规则

每次退回必须记录以下审计信息：

1. 操作人。
2. 来源节点。
3. 目标节点。
4. 退回原因。
5. 退回时实例有效数据快照摘要。

## 10. 自动节点规则

### 10.1 自动节点启动条件

自动节点被激活时，系统按节点定义绑定的资源和输入快照执行。

自动节点执行期间不生成人工任务。

自动节点通过 BPMN ServiceTask 实现，委托类 `DshServiceTaskDelegate` 通过 REST 调用服务器端 DSH web profile 执行（LLM 调用 + skill 加载 + 脚本运行），把响应 output/notes 写回实例变量供下游节点消费。详见 §14。

### 10.2 自动节点失败规则

自动节点失败后按节点配置执行以下三选一策略之一：

1. 自动重试。
2. 转人工处理。
3. 进入异常并等待管理员干预。

若选择自动重试，则每次重试都复用相同输入快照和相同资源修订标识。

V1 通过 BPMN `flowable:async="true"` + `flowable:failedJobRetryTimeCycle`（如 `R5/PT5M`）实现异步执行 + 自动重试：WebClient 抛异常后 Job 进入 `ACT_RU_JOB` 异常重试队列，按 ISO-8601 间隔重试；全部失败后 Job 标记 deadletter（`ACT_RU_DEADLETTER`），流程实例停留于本节点等待人工干预（转人工或管理员重试，见 §11.3）。详见 §14.4。

### 10.3 skill 预装机制

V1 不在企业层维护资源目录，skill 由员工 PC 的 DSH 定时任务预装到本地。

预装流程：

1. 员工 PC 的 enterprise profile 启动后，本地定时任务（作为设置项，默认每 5 分钟）扫描当前用户的待办。
2. 对每个待办，解析其流程版本 BPMN 中节点 `dsh:` extensionElements 的 `skillRefs`，取并集。
3. 检查本地已装 skill，缺失的预安装到本地 DSH。
4. 会话创建时，`userPrompt` 中写明的 skill 名称即引用已预装 skill 加载，无需运行时动态启用 skill 子集。

服务器端：

1. 服务器端 DSH（web profile）执行自动节点时，其所需 skill 由服务器端 DSH 按 ServiceTask 绑定的 `skillRefs` 预装，机制与员工 PC 类似但运行在服务器。

设置项：

1. 预装定时任务作为 enterprise profile 的设置项，可配置开关与频率（默认开启、每 5 分钟）。

## 11. 管理员干预规则

管理员干预只开放给具备应用运行干预权限的应用管理员或系统管理员。

### 11.1 跳转节点

`跳转节点` 表示将运行中的实例直接切换到指定目标节点。

规则：

1. 只允许对 `running` 或 `exception` 状态实例执行。
2. 目标节点必须属于该实例绑定的同一流程版本。
3. 当前活跃节点实例全部置为 `skipped`，原因标记为 `admin_jump`。
4. 当前活跃任务全部置为 `closed`。
5. 系统基于 `currentEffectiveData` 激活目标节点，创建新的节点实例。
6. 跳转后实例状态统一回到 `running`。

### 11.2 终止实例

`终止实例` 表示强制结束一个未进入终态的流程实例。

规则：

1. 只允许对 `running`、`exception`、`suspended` 状态实例执行。
2. 终止后实例状态进入 `terminated`。
3. 所有活跃节点实例停止推进。
4. 所有未完成任务置为 `closed`。
5. 不再允许该实例产生新的普通节点实例和任务。

### 11.3 重试自动节点

`重试自动节点` 表示对失败的自动节点再次执行。

规则：

1. 只允许对当前状态为 `exception` 的自动节点实例执行。
2. 重试时沿用原节点输入快照。
3. 重试时沿用原资源绑定和原修订标识。
4. 每次重试都增加 `retryCount`。
5. 重试成功后节点进入 `completed`，实例回到 `running`。
6. 重试失败后节点保持 `exception`。

### 11.4 通知与审计

每次管理员干预都必须：

1. 生成审计事件。
2. 通知当前受影响的任务处理人。
3. 在实例运行历史中生成一条系统可见记录。

## 12. 关键不变量

以下规则在整个 V1 实现中必须始终成立。

1. 流程实例永远绑定创建时的流程版本。
2. 已发布流程版本永远只读。
3. 节点输入输出契约不允许在运行期漂移。
4. 自动节点的重试不得切换到不同资源修订标识。
5. 退回和跳转都不得删除历史节点记录。
6. 管理员干预不得绕过审计。
7. 用户只有在同时满足应用访问、角色授权、节点授权和资源调用授权时才能调用资源。
8. 角色继承不形成循环，且只在所属应用内生效；继承只扩展可见任务范围，不改变节点责任角色绑定。
9. 职责分离校验不得被绕过；审批类节点的处理人不得为流程发起人。
10. 应用之间角色与角色-用户绑定关系隔离：BPMN 节点的 `assignmentRule.candidateRoleId` 与 BPMN 原生 `flowable:candidateGroups` 引用的 role_id 必须属于该 BPMN 所属应用；同一用户在不同应用的成员记录与可见待办互不串扰（详见 §13.4）。

## 13. 存储设计

### 13.1 schema 划分

| schema | 用途 | 表前缀 | 管理方 |
|--------|------|--------|--------|
| `public` | 平台业务表（用户治理、企业治理元数据） | 无前缀 | Web Console 后端（JDBC 直连 CRUD）、Node `platform-user-supabase`（Supabase API）、Flowable 引擎（只读查 `app_memberships` 做 SoD 过滤） |
| `flowable` | Flowable 引擎运行时 + 历史 | `ACT_*` | Flowable 引擎自动建表与管理，其他组件不直接操作 |

### 13.2 public schema 表清单

| 表 | SPEC 对象 | 管理方 |
|----|----------|--------|
| `platform_users` | PlatformUser（§5.1） | Node `platform-user-supabase`（Supabase API）；Web Console 后端只读 |
| `audit_events` | AuditEvent（§5.11） | Node `platform-user-supabase`（Supabase API）；Web Console 后端只读 |
| `applications` | Application（§5.2） | Web Console 后端（JDBC 直连） |
| `app_roles` | AppRole（§5.3） | Web Console 后端（JDBC 直连）；Flowable 引擎只读（查 `parent_role_id` 做角色继承，由 task-api 层做） |
| `app_memberships` | AppMembership（§5.4） | Web Console 后端（JDBC 直连）；Flowable 引擎只读（`DshMembershipRepository.findActiveUserIdsByRoleId` 做 SoD 候选过滤） |
| `workflow_definitions` | WorkflowDefinition（§5.6） | Web Console 后端（JDBC 直连，存草稿 + 发布引用） |

不单独建表的对象：
- `WorkflowVersion`（原 §4.7）：映射到 Flowable `ACT_RE_PROCDEF`，DSH 通过 Flowable RepositoryService 访问。
- `WorkflowNodeDefinition`（§5.7）：节点 dsh 元数据写在 BPMN XML 的 `dsh:` extensionElements，随 BPMN 单一存储。
- `WorkflowInstance`（§5.8）：映射到 Flowable `ACT_RU_EXECUTION` + `ACT_HI_PROCINST`。
- `NodeInstance`（§5.9）：映射到 Flowable `ACT_HI_ACTINST`（历史活动）。
- `Task`（§5.10）：映射到 Flowable `ACT_RU_TASK` + `ACT_HI_TASKINST`；扩展状态通过 task-local 变量实现。
- `resource_catalog_items`：已删除，V1 不在企业层维护资源目录（见 §5.5）。

### 13.3 flowable schema（ACT_* 表）

Flowable 7 引擎启动时根据配置自动在 `flowable` schema 创建 `ACT_*` 系列表，无需手动建表。

| 前缀 | 含义 | 关键表 |
|------|------|--------|
| `ACT_RE_*` | Repository 仓库 | `ACT_RE_DEPLOYMENT`（部署）、`ACT_RE_PROCDEF`（流程定义）、`ACT_GE_BYTEARRAY`（BPMN XML） |
| `ACT_RU_*` | Runtime 运行时 | `ACT_RU_EXECUTION`（执行实例）、`ACT_RU_TASK`（用户任务）、`ACT_RU_VARIABLE`（变量）、`ACT_RU_JOB`（异步 job）、`ACT_RU_DEADLETTER`（死信 job） |
| `ACT_HI_*` | History 历史 | `ACT_HI_PROCINST`（历史实例）、`ACT_HI_TASKINST`（历史任务）、`ACT_HI_ACTINST`（历史活动）、`ACT_HI_VARINST`（历史变量） |
| `ACT_GE_*` | General 通用 | `ACT_GE_PROPERTY`（引擎属性、schema version） |

Flowable 引擎配置 `spring.flowable.database-schema=flowable` 和 `spring.flowable.database-schema-update=true` 后，首次启动自动建表。DSH 不直接操作这些表，全部通过 Flowable Java API 或 REST API 间接访问。

历史级别配置为 `HistoryLevel.FULL`，所有历史表（`ACT_HI_*`）都写入数据，满足历史/审计接口查询前提（见 §14.6）。

### 13.4 应用隔离设计

应用是平台一级治理单元（§5.2），应用之间在角色、角色-用户绑定、BPMN 定义、流程实例、待办五个维度严格隔离，互不串扰。本节汇总应用隔离在各层的实现结论。

#### 13.4.1 隔离模型

| 维度 | 隔离规则 | 实现层 |
|------|---------|--------|
| 应用 | 每个应用有独立 `id`，应用之间数据互不可见 | `public.applications`（id 主键） |
| 角色 | 应用内角色名唯一；角色只在所属应用内生效；不允许跨应用继承 | `public.app_roles`（`app_id` 外键 + `UNIQUE(app_id, name)` + `parent_role_id` 应用层校验同应用） |
| 角色-用户绑定 | 同一用户同一应用只有一条有效成员记录；角色绑定只在该应用内有效 | `public.app_memberships`（`app_id` 外键 + `UNIQUE(app_id, user_id)`） |
| BPMN 定义 | 一个应用可创建多个 BPMN；一个 BPMN 只属于一个应用；BPMN 节点引用的 role_id 必属于该 BPMN 所属应用 | `public.workflow_definitions`（`app_id` 外键）；Web Console 发布前校验 role_id 归属 |
| 待办 | 同一用户在不同应用的成员记录不会让对方在另一应用的待办中看到候选任务 | 引擎层按 `role_id` 全局唯一 UUID 查询天然隔离；task-api 层按有效角色集查询同样隔离 |

#### 13.4.2 各层实现职责

1. **存储层（Supabase PG）**：所有治理元数据表都带 `app_id` 外键，`app_roles` 与 `app_memberships` 还有应用级 UNIQUE 约束，从数据库层面保证应用内唯一性。跨应用的引用完整性（如 BPMN 节点引用的 role_id 必属本应用）PG 不原生支持数组外键，由应用层校验。

2. **Web Console 后端**：
   - 在创建应用、角色、成员、BPMN 定义时，所有写操作都带 `app_id`，确保数据归属正确。
   - 在发布 BPMN 前，校验 BPMN 节点的 `assignmentRule.candidateRoleId` 与 `flowable:candidateGroups` 引用的 role_id 必属本 BPMN 所属应用（对应 §12.10 不变量）。校验失败拒绝发布，返回可读说明。
   - 在生成 BPMN XML 时，`flowable:candidateGroups` 写入的是应用内 role_id（UUID）。

3. **Flowable 引擎层**（`apps/flowable-engine/`）：
   - 引擎不感知"应用"概念，不重复校验 role_id 归属；隔离由存储层外键 + Web Console 应用层校验保证。
   - `DshMembershipRepository.findActiveUserIdsByRoleId(roleId)` 按 role_id 查 `public.app_memberships`：由于 role_id 是 `app_roles.id` 主键 UUID，全局唯一且只属于一个应用，查询天然只返回该应用下该角色的成员，不会跨应用串扰。
   - `DshSodFilter.filterMutexNode` 按 `processInstanceId` 查历史 task：流程实例必属一个流程定义，流程定义必属一个应用（通过 `workflow_definitions.app_id`），mutex-node 排除集天然限定在同一应用内。
   - `DshTaskListener` 注入 `dsh_node_meta` 不涉及 role_id 解析，无跨应用风险。

4. **DSH task-api 层**（enterprise profile）：
   - 查询用户待办时，按 user_id 查 `public.app_memberships` 拿直接授予的 role_ids，递归展开 `parent_role_id` 拿有效角色集，再查 Flowable 候选 task（§7.6.1）。
   - 由于 `app_memberships` 的 `app_id` 字段限定，user 在应用 A 的角色不会让他在应用 B 的待办中看到候选任务；查询天然按应用隔离。

#### 13.4.3 跨应用场景的处理

| 场景 | 处理 |
|------|------|
| 同一用户在多个应用有成员记录 | 各应用独立一条 `app_memberships` 记录（`UNIQUE(app_id, user_id)`）；查询待办时按各应用分别展开角色，互不串扰 |
| 应用 A 的 BPMN 误写应用 B 的 role_id | Web Console 发布前校验拒绝；如绕过 Web Console 直接部署 BPMN，引擎层不报错但查 `app_memberships` 会返回应用 B 的成员作为候选（数据正确性受损但不崩溃）；V1 单企业内部信任，依赖 Web Console 把关 |
| 应用归档（archived）后 | 该应用不允许新建 BPMN 版本和发起新实例（§5.2 规则 3、§6.2 状态机）；已有历史实例和待办保留可查 |
| 角色跨应用继承 | 不允许（§5.3 规则 2、§7.6 规则 6）；`parent_role_id` 必须指向同一应用内的角色，由应用层校验 `app_id` 一致 |

#### 13.4.4 验证要点

参见 [Flowable 引擎验证指南 §0.4](file:///d:/works/deepseek-harness/apps/flowable-engine/2026-08-21-flowable-engine-verification-guide.md) 的应用隔离可选验证。

## 14. Flowable 引擎实现

Flowable 引擎作为独立 Spring Boot 服务部署在 `apps/flowable-engine/`，是流程运行域的核心实现。

### 14.1 项目结构

```
apps/flowable-engine/
├── pom.xml
├── examples/
│   └── sample-approval-process.bpmn20.xml  # 示例 BPMN(async=true + dsh: 元数据)
├── src/main/java/com/dsh/flowable/
│   ├── FlowableEngineApplication.java       # Spring Boot 主类
│   ├── config/
│   │   ├── SupabaseJwtProperties.java       # dsh.supabase.* 配置属性
│   │   ├── DshWebProfileProperties.java      # dsh.web-profile.* 配置属性
│   │   ├── SecurityConfig.java              # Supabase JWT 本地验证
│   │   └── FlowableConfig.java               # 引擎历史级别 + ParseHandler 注册
│   ├── listener/
│   │   ├── DshExtensionProperties.java      # dsh: 元数据 POJO
│   │   ├── DshBpmnExtensionParser.java      # UserTask extensionElements → POJO
│   │   ├── DshBpmnParseHandler.java        # 部署时注入 DshTaskListener create 事件
│   │   ├── DshExtensionPropertiesCache.java # 进程级 lazy cache(改进2)
│   │   ├── DshTaskListener.java             # TASK_CREATED 时注入 task-local 变量 + SoD 过滤
│   │   └── DshSodFilter.java                # SoD not-applicant / mutex-node 规则
│   ├── delegate/
│   │   ├── AutoNodeRequest.java             # 调 DSH web profile 请求体
│   │   ├── AutoNodeResponse.java            # DSH web profile 响应体
│   │   └── DshServiceTaskDelegate.java      # ServiceTask 委托类(支持 async)
│   ├── repository/
│   │   └── DshMembershipRepository.java      # 查 public.app_memberships 拿角色下 users
│   └── api/
│       ├── TaskDto.java                     # 运行时任务 DTO(含 dsh 元数据)
│       ├── HistoricTaskDto.java             # 历史任务 DTO(改进3)
│       ├── HistoricProcessInstanceDto.java  # 历史实例 DTO(改进3)
│       ├── HistoricActivityDto.java         # 历史活动 DTO(改进3)
│       ├── DshTaskController.java            # /dsh/tasks/* 运行时薄封装
│       └── DshHistoryController.java         # /dsh/history/* 历史审计薄封装(改进3)
└── src/main/resources/
    ├── application.yml                      # 主配置(async-executor 线程池等)
    └── application-dev.yml                 # 开发环境配置
```

### 14.2 关键设计

| 关注点 | 实现 |
|--------|------|
| dsh: 元数据解析 | `DshTaskListener` 监听 `TASK_CREATED`，从 BPMN model 读 extensionElements 解析为 `DshExtensionProperties` POJO，JSON 序列化后注入 task-local 变量 `dsh_node_meta` |
| dsh: 元数据缓存 | `DshExtensionPropertiesCache`（进程级 `ConcurrentHashMap`）按 `(procdefId, taskDefKey)` 缓存解析结果；首次 task create miss 时解析并回填，后续同节点实例直接读 cache（见 §14.5） |
| Supabase JWT | `SecurityConfig` 注册 `NimbusJwtDecoder` 用 `dsh.supabase.jwt-secret` 验证 HS256，iss 校验为 Supabase Project URL |
| 自动节点 | `DshServiceTaskDelegate`（JavaDelegate），BPMN 中用 `flowable:delegateExpression="${dshServiceTaskDelegate}"` 引用；通过 WebClient 调服务器端 DSH web profile 执行（见 §14.4） |
| 异步 ServiceTask | BPMN ServiceTask 配 `flowable:async="true"`，引擎在节点激活时创建 async Job，由 `async-executor` 线程池异步消费；主流程推进线程不阻塞（见 §14.4） |
| 任务薄封装 | `DshTaskController` 提供 `/dsh/tasks/my-tasks`（assignee=sub）、`/dsh/tasks/{taskId}`（含 dsh 元数据）；认领/转交/完成直接用 Flowable 自带 REST |
| 历史审计 | `DshHistoryController` 提供 `/dsh/history/tasks`、`/dsh/history/process-instances`、`/dsh/history/activities` 薄封装端点（见 §14.6） |
| 输出校验 | 不在引擎侧；在 DSH enterprise profile 的 task-api complete 端点用 ajv（§8.8） |

### 14.3 BPMN dsh: 命名空间元数据

DSH 特有元数据写在 BPMN 的 `dsh:` extensionElements 命名空间，随 BPMN 单一存储，不单独建表。解析方案：`TaskListener + BpmnParseHandler`（避开 Flowable 7 `TaskEntity` internal package 限制）。

1. **`DshBpmnParseHandler`**（实现 `BpmnParseHandler`）：在 BPMN 部署解析阶段，为所有 `UserTask` 自动注入 `DshTaskListener` 的 create 事件（通过 `delegateExpression="${dshTaskListener}"`）。在 `FlowableConfig` 中注册到 `postBpmnParseHandlers`。

2. **`DshBpmnExtensionParser`**：从 `UserTask` 的 extensionElements 解析 `dsh:` 命名空间元素，构造 `DshExtensionProperties` POJO（含 `assignmentRule`、`inputSchema`、`outputSchema`、`systemPrompt`、`userPrompt`、`skillRefs`、`actionPolicy`）。

3. **`DshTaskListener`**（实现 `TaskListener`，Spring bean `dshTaskListener`）：在 task create 事件触发时：
   - 从 cache 或 BpmnModel 解析节点 dsh 元数据为 `DshExtensionProperties` POJO。
   - JSON 序列化后注入 task-local 变量 `dsh_node_meta` 和 `dsh_node_id`。
   - 若 `actionPolicy.sodRules` 非空，调 `DshSodFilter` 应用规则过滤候选 users（见 §7.7.1）。

4. **`DshSodFilter`**：实现 `not-applicant`（从实例变量 `dsh_applicant_user_id` 拿申请人排除）和 `mutex-node`（查同实例其他节点 `.finished()` historic task 的 assignee 排除）规则。

5. **`DshMembershipRepository`**：通过 `JdbcTemplate` 查 `public.app_memberships`，按 role_id 拿该角色下的直接 active user_ids（`SELECT user_id::text FROM public.app_memberships WHERE status = 'active' AND role_ids @> ARRAY[?::uuid]`）。

### 14.4 异步 ServiceTask（V1 改进）

LLM 自动节点耗时长（数十秒到分钟级），同步执行会阻塞流程实例推进线程。改进措施：

1. **BPMN 端**：ServiceTask 配 `flowable:async="true"`，引擎不直接同步执行，改为在节点激活时创建 async Job 写入 `ACT_RU_JOB`，主流程立即推进到下游（或下一个 async 边界）。

2. **执行端**：`async-executor` 线程池（yaml `spring.flowable.async-executor-core-pool-size/max-pool-size/queue-capacity` 调优）异步拉取 Job 调用 `DshServiceTaskDelegate`。本委派内部仍用 WebClient 同步阻塞调用 DSH web profile，但执行线程是 async-executor 工作线程，不阻塞流程实例线程。

3. **失败重试**：BPMN 配 `flowable:failedJobRetryTimeCycle="R5/PT5M"`（重试 5 次，间隔 5 分钟），WebClient 抛异常后 Job 进入异常队列按周期重试；全部失败后 Job 标记 deadletter（`ACT_RU_DEADLETTER`），流程实例停留于本节点等待人工干预（§10.2 转人工或 §11.3 管理员重试）。

示例 BPMN（见 `examples/sample-approval-process.bpmn20.xml`）：

```xml
<serviceTask id="autoArchiveTask" name="自动归档"
             flowable:delegateExpression="${dshServiceTaskDelegate}"
             flowable:async="true"
             flowable:failedJobRetryTimeCycle="R5/PT5M"/>
```

async-executor 线程池调优参考（application.yml）：
- `core-pool-size=4`：常驻线程；LLM 调用 I/O 密集，可适当大于 CPU 核数。
- `max-pool-size=16`：突发并发上限；生产环境按实例并发度调。
- `queue-capacity=1000`：待执行 Job 等待队列；满了新 Job 拒绝并打 ERROR 日志，实际很难触达。
- `async-job-lock-time=300000`（5 分钟）：避免多实例并发抢同一 Job 时重复执行。

### 14.5 dsh 元数据缓存（V1 改进）

`DshExtensionPropertiesCache` 是进程级 `ConcurrentHashMap`，避免每次 task create 重新查 BpmnModel + 解析 extensionElements。

1. **缓存键**：`procdefId + "#" + taskDefKey`。Flowable 部署新版本时生成新 procdefId，旧版本对应 key 自然不再被引用，GC 后释放；V1 单企业单实例无需显式 invalidate。

2. **缓存值**：用 `Optional<DshExtensionProperties>` 区分"未缓存"（返回 `null`，调用方应 fallback 解析）与"已缓存但节点无 dsh 元素"（返回 `Optional.empty()`，直接跳过）。后者避免每次都 fallback 到 BpmnModel 重新解析。

3. **填充时机**：`DshTaskListener.notify()` 中先查 cache，miss 时 fallback 查 BpmnModel + `DshBpmnExtensionParser.parse()` + `cache.put` 回填。部署阶段（`DshBpmnParseHandler.parse()`）拿不到 procdefId（流程定义 id 在部署后才生成），不预热 cache。

4. **线程安全**：基于 `ConcurrentHashMap`。部署顺序保证 procdefId 在 task create 之前已就绪；并发 task create 同一节点时若同时 miss，最坏并发解析 N 次并 `put` N 次覆盖，结果幂等（同一 UserTask 多次解析结果一致），无正确性风险。

5. **SoD 过滤路径例外**：SoD 过滤需要原始 `UserTask`（含 BPMN 原生 `candidateUsers`/`candidateGroups` 字段，cache POJO 只存 dsh 元数据），仍走 BpmnModel。这是有意的——常规任务只读 cache 即可完成元数据注入，SoD 过滤属少见路径。

### 14.6 历史/审计接口（V1 改进）

`DshHistoryController` 在 Flowable 自带 `/process-api/history/*` 之上做薄封装，按 DSH 业务常用维度简化参数，并拼装 `dsh_node_meta` 元数据 POJO。

| 端点 | 说明 |
|------|------|
| `GET /dsh/history/tasks` | 历史任务（可选按 `processInstanceId`/`assignee`/`finished` 过滤，分页 `page`/`size`）。不传 `assignee` 时默认按当前 JWT 用户过滤；查全部传 `assignee=__all__` 待 V2 |
| `GET /dsh/history/process-instances` | 历史实例（可选按 `startedBy`/`finished`/`processDefinitionKey` 过滤，分页） |
| `GET /dsh/history/activities` | 历史活动（必填 `processInstanceId`，不分页，回溯流程走过的全部节点） |

返回字段见 `HistoricTaskDto` / `HistoricProcessInstanceDto` / `HistoricActivityDto`。

- 历史任务查询用 `includeTaskLocalVariables` 一次查齐 local 变量，从 `dsh_node_meta` 还原 `DshExtensionProperties` POJO，避免逐条回查。
- 历史实例查询补查 `RepositoryService.createProcessDefinitionQuery` 拿流程定义名称/key/版本（historic 接口字段差异规避）。
- 正常完成的实例 `deleteReason` 为 null；被管理员强制终止的实例 `deleteReason` 非 null。Flowable 7 OSS 不在 historic 接口暴露 `endState` 枚举（商业版扩展），V1 用 `deleteReason` 区分结束类型。
- 分页参数：默认 `size=50`，最大 `size=200`（clamp 防止前端误传大 size 拖垮引擎）。
- V1 单企业内部信任，任何已认证用户都能查全部历史；V2 可加按部门/角色可见范围过滤。

## 15. 最小验收场景

研发和测试至少要以以下场景验证实现是否符合产品定义。

1. 系统管理员审批新用户并分配平台角色，用户成功登录。
2. 应用管理员创建应用、角色、成员。
3. 应用管理员创建流程草稿并发布。
4. 普通用户发起流程实例，人工节点生成待办。
5. 单人任务完成后流程进入下一节点。
6. 会签节点生成多个并行任务，全部提交后节点完成。
7. 串签节点按顺序生成任务，最后一人提交后节点完成。
8. 当前任务被转交后，原任务失效，新任务可继续处理。
9. 当前节点加签后，新增处理人被插入处理链。
10. 当前人工节点退回到历史节点，下游活动任务全部关闭。
11. 自动节点失败后重试成功，实例恢复运行。
12. 管理员跳转节点后，实例从目标节点继续推进。
13. 管理员终止实例后，不再生成新任务。
14. 上级角色用户可查询并认领下级角色的候选任务，认领后任务正常流转。
15. 审批类节点提交时，若处理人与流程发起人为同一人，系统拒绝并返回可读说明。
16. 人工节点超时未处理，任务自动升级到目标用户，原任务关闭并记录审计。
17. 异步 ServiceTask 执行时主流程不阻塞，async Job 由线程池消费。
18. 同节点多次 task create 时 dsh 元数据缓存命中，不重复查 BpmnModel。
19. 历史/审计接口可按实例/处理人/状态查询历史任务、历史实例、历史活动。

## 16. 开发顺序建议

为了尽快形成可跑通的最小闭环，推荐采用以下实现顺序。

1. 身份、平台角色、应用、应用角色、成员授权。
2. 流程定义、版本发布、节点契约校验。
3. 流程实例、节点实例、单人任务流转。
4. 会签、串签、转交、加签。
5. 自动节点、失败处理、管理员干预。
6. 审计、运行监控、通知。

这个顺序的目标是先打通最小流程闭环，再叠加复杂动作和治理能力。
