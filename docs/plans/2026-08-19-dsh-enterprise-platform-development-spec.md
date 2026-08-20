# DSH 企业级应用平台 V1 开发细化 SPEC

## 文档信息

- 文档状态：Final
- 文档日期：2026-08-19
- 适用读者：架构师、后端工程师、前端工程师、测试工程师
- 文档目标：在总 SPEC 基础上，将 V1 的核心产品规则细化到可直接指导代码开发、接口设计、数据建模和测试设计的程度

## 1. 文档定位

本文是 [DSH 企业级应用平台产品 SPEC](file:///d:/works/deepseek-harness/docs/plans/2026-08-19-dsh-enterprise-platform-spec.md) 的开发级补充文档。

总 SPEC 负责定义产品边界、核心对象和 V1 范围。

本文负责定义开发必须依赖的精确规则，包括对象字段、不变量、状态机、操作语义、流程运行规则、退回规则和管理员干预规则。

本文仍然不讨论技术选型、数据库表结构实现、接口框架和部署方案。

## 2. 开发就绪标准

研发可以开始编码的前提，不是“知道系统要做什么”，而是“知道对象如何变化、谁能做什么、什么时候允许做、做完后系统状态变成什么样”。

V1 研发必须以本文定义的以下内容为准：

1. 核心业务对象和必填字段。
2. 每个对象的状态集合和状态迁移规则。
3. 每个用户动作和系统动作的触发条件、结果和审计要求。
4. 流程实例、节点实例、待办和资源之间的绑定关系。
5. 退回、转交、加签、管理员干预等高风险动作的确定语义。

## 3. V1 功能切片

为了让研发能够并行推进，V1 功能拆分为六个开发域。

1. 身份与平台治理域。
2. 应用与角色治理域。
3. 资源目录域。
4. 流程定义域。
5. 流程运行域。
6. 审计与运行监控域。

所有代码设计都应能映射到这六个开发域之一，不在这六个域中的能力不纳入 V1。

## 4. 核心对象与必填字段

### 4.1 PlatformUser

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

### 4.2 Application

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

### 4.3 AppRole

`AppRole` 表示应用内业务角色。

必填字段：

1. `id`
2. `appId`
3. `name`
4. `description`
5. `status`
6. `createdAt`
7. `createdBy`

规则：

1. 应用内角色名称唯一。
2. 应用角色只在所属应用内生效。
3. V1 的成员授权只基于角色，不引入部门、组织、岗位维度。

### 4.4 AppMembership

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

### 4.5 ResourceCatalogItem

`ResourceCatalogItem` 表示可被流程节点绑定和调用的资源。

必填字段：

1. `id`
2. `scopeType`
3. `scopeId`
4. `resourceType`
5. `name`
6. `description`
7. `status`
8. `visibilityRoles`
9. `configurableRoles`
10. `callableRoles`
11. `revisionRef`
12. `createdAt`
13. `createdBy`

说明：

1. `scopeType` 只允许 `platform` 或 `application`。
2. `scopeId` 在 `platform` 时为空，在 `application` 时必须是应用 ID。
3. `resourceType` 只允许 `skill`、`mcp`、`knowledge`、`llm`、`script`。
4. `revisionRef` 是资源运行期追溯标识。

### 4.6 WorkflowDefinition

`WorkflowDefinition` 表示流程定义。

必填字段：

1. `id`
2. `appId`
3. `name`
4. `description`
5. `status`
6. `publishedVersion`
7. `createdAt`
8. `createdBy`
9. `updatedAt`
10. `updatedBy`

规则：

1. 流程定义只属于一个应用。
2. V1 只允许草稿版本编辑，已发布版本只读。
3. 发起流程实例时必须绑定一个已发布版本。

### 4.7 WorkflowVersion

`WorkflowVersion` 表示流程定义的一个可运行版本。

必填字段：

1. `id`
2. `workflowDefinitionId`
3. `versionNo`
4. `status`
5. `startNodeId`
6. `endNodeIds`
7. `nodeDefinitions`
8. `edges`
9. `resourceBindings`
10. `publishedAt`
11. `publishedBy`

规则：

1. `versionNo` 在同一流程定义下递增。
2. 一个流程定义在同一时刻只有一个当前发布版本。
3. 发布后版本内容不可修改。

### 4.8 WorkflowNodeDefinition

`WorkflowNodeDefinition` 表示流程版本中的一个节点。

必填字段：

1. `id`
2. `workflowVersionId`
3. `name`
4. `nodeType`
5. `assignmentRule`
6. `inputSchema`
7. `outputSchema`
8. `actionPolicy`
9. `resourceBindings`
10. `routingRule`

说明：

1. `nodeType` 只允许 `start`、`human`、`auto`、`condition`、`merge`、`end`。
2. `assignmentRule` 只适用于 `human` 节点。
3. `actionPolicy` 定义该节点允许的人工动作和策略。

### 4.9 WorkflowInstance

`WorkflowInstance` 表示某个流程版本的一次真实执行。

必填字段：

1. `id`
2. `workflowDefinitionId`
3. `workflowVersionId`
4. `appId`
5. `status`
6. `startUserId`
7. `startedAt`
8. `endedAt`
9. `endReason`
10. `currentEffectiveData`
11. `currentActiveNodeInstanceIds`

规则：

1. 实例一旦创建，其 `workflowVersionId` 不可变。
2. `currentEffectiveData` 表示实例当前有效业务数据快照。
3. 实例处于终态后，不允许再产生新的普通节点实例。

### 4.10 NodeInstance

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

### 4.11 Task

`Task` 表示人工节点分配给人的工作单元。

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

### 4.12 AuditEvent

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

## 5. 状态机定义

### 5.1 PlatformUser 状态机

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

### 5.2 Application 状态机

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

### 5.3 ResourceCatalogItem 状态机

状态集合：

1. `draft`
2. `published`
3. `offline`

迁移规则：

1. 新资源创建后进入 `draft`。
2. 应用管理员或系统管理员发布后进入 `published`。
3. 已发布资源可下线为 `offline`。
4. `offline` 资源不可被新的流程版本引用。

### 5.4 WorkflowDefinition 状态机

状态集合：

1. `draft`
2. `published`
3. `disabled`

迁移规则：

1. 新流程定义进入 `draft`。
2. 草稿通过校验后可发布为 `published`。
3. 已发布流程可停用为 `disabled`。
4. `disabled` 流程不允许新实例启动。

### 5.5 WorkflowInstance 状态机

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

### 5.6 NodeInstance 状态机

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

### 5.7 Task 状态机

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

## 6. 人工节点策略定义

### 6.1 单人处理

默认人工节点策略是单人处理。

系统根据节点责任规则解析出一个处理人，只生成一个任务。

任务提交后，节点即完成。

### 6.2 会签

`会签` 表示一个人工节点同时分配给多个处理人并行处理。

V1 定义：

1. 节点激活时一次性生成多个并行任务。
2. 所有任务都提交后，节点才完成。
3. 节点输出为全部任务结果的聚合数组。
4. 路由规则读取聚合结果，不读取任一单个任务作为默认最终结论。

V1 不提供“多数通过”“一票否决”这类内置审批算法。若业务需要，必须在节点输出契约和路由规则中显式定义。

### 6.3 串签

`串签` 表示一个人工节点由多个处理人按既定顺序依次处理。

V1 定义：

1. 节点激活时只创建第一个处理人的任务。
2. 当前任务提交后，系统创建下一个处理人的任务。
3. 最后一个任务提交后，节点才完成。
4. 每个处理人的结果都被保留，节点输出为按顺序排列的结果数组。

### 6.4 转交

`转交` 表示当前任务处理人将任务处理权移交给另一个用户。

V1 定义：

1. 转交只能发生在任务提交前。
2. 转交后原任务状态变为 `transferred`。
3. 系统新建一条新的 `pending` 任务给目标用户。
4. 新任务继承原任务的输入快照和节点上下文。
5. 转交不改变节点策略，只改变当前处理人。

转交目标用户必须满足该节点的处理权限要求。

### 6.5 加签

`加签` 表示在当前人工节点完成前追加额外处理人。

V1 只支持串行加签，不支持并行加签和前加签。

V1 定义：

1. 当前任务处理人或应用管理员可以发起加签。
2. 加签后，系统在当前处理链后面插入一个新的处理人。
3. 当前处理人提交后，新增处理人的任务被创建。
4. 新增处理人提交后，原处理链继续。
5. 节点完成条件随处理链长度动态变化。

这样设计的目标是降低状态机复杂度，同时满足企业最常见的加签诉求。

## 7. 人工节点动作语义

### 7.1 开始处理

触发条件：

1. 任务状态为 `pending` 或 `saved`。
2. 当前用户是任务处理人。

结果：

1. 任务状态进入 `in_progress`。
2. 记录开始处理时间。

### 7.2 暂存

触发条件：

1. 任务状态为 `in_progress`。
2. 当前用户是任务处理人。

结果：

1. 任务状态进入 `saved`。
2. 保存当前临时结果，不触发节点流转。

### 7.3 提交

触发条件：

1. 任务状态为 `in_progress` 或 `saved`。
2. 当前用户是任务处理人。
3. 当前输出通过节点输出契约校验。

结果：

1. 任务状态进入 `submitted`。
2. 写入 `resultSnapshot`。
3. 根据节点策略决定是否完成节点或创建后续任务。

### 7.4 退回

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

### 7.5 转交

触发条件：

1. 当前任务状态为 `pending`、`in_progress` 或 `saved`。
2. 当前用户是任务处理人。
3. 目标用户满足该节点的处理权限要求。

结果：

1. 当前任务状态进入 `transferred`。
2. 系统新建一条新的 `pending` 任务给目标用户。
3. 新任务继承当前任务的输入快照和节点上下文。
4. 转交动作不改变节点实例状态。

### 7.6 加签

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

### 7.7 请求补充信息

触发条件：

1. 当前用户是有效任务处理人。
2. 当前任务状态为 `in_progress` 或 `saved`。

结果：

1. 任务保持原状态。
2. 生成一条补充信息请求记录。
3. 不触发流程流转。

## 8. 退回规则

V1 的退回规则采用“历史保留、当前数据带回、下游实例失效”的模型。

### 8.1 允许范围

1. 只允许退回到当前实例中已经执行过的历史节点。
2. 不允许退回到从未执行过的未来节点。
3. 退回到未来节点属于管理员跳转，不属于退回。

### 8.2 数据规则

1. 系统不删除任何历史节点输出。
2. 当前实例的 `currentEffectiveData` 在退回时作为目标节点的新输入基线。
3. 系统在目标节点输入中额外附加退回原因、退回来源节点和退回时间。
4. 被退回前的后续节点输出保留为历史，但不再参与当前有效路径的数据计算。

### 8.3 历史规则

1. 历史节点实例和任务记录全部保留。
2. 因退回失效的后续节点实例统一标记为 `skipped`。
3. 因退回失效的后续任务统一标记为 `closed`。

### 8.4 审计规则

每次退回必须记录以下审计信息：

1. 操作人。
2. 来源节点。
3. 目标节点。
4. 退回原因。
5. 退回时实例有效数据快照摘要。

## 9. 自动节点规则

### 9.1 自动节点启动条件

自动节点被激活时，系统按节点定义绑定的资源和输入快照执行。

自动节点执行期间不生成人工任务。

### 9.2 私有脚本规则

应用私有脚本视为应用私有资源的一种。

V1 采用轻量治理模式：

1. 应用管理员直接维护应用私有脚本。
2. 不单独设计脚本审核流。
3. 流程发布时必须固定脚本的 `revisionRef`。
4. 自动节点重试时必须沿用原实例绑定的脚本 `revisionRef`。

### 9.3 自动节点失败规则

自动节点失败后按节点配置执行以下三选一策略之一：

1. 自动重试。
2. 转人工处理。
3. 进入异常并等待管理员干预。

若选择自动重试，则每次重试都复用相同输入快照和相同资源修订标识。

## 10. 管理员干预规则

管理员干预只开放给具备应用运行干预权限的应用管理员或系统管理员。

### 10.1 跳转节点

`跳转节点` 表示将运行中的实例直接切换到指定目标节点。

规则：

1. 只允许对 `running` 或 `exception` 状态实例执行。
2. 目标节点必须属于该实例绑定的同一流程版本。
3. 当前活跃节点实例全部置为 `skipped`，原因标记为 `admin_jump`。
4. 当前活跃任务全部置为 `closed`。
5. 系统基于 `currentEffectiveData` 激活目标节点，创建新的节点实例。
6. 跳转后实例状态统一回到 `running`。

### 10.2 终止实例

`终止实例` 表示强制结束一个未进入终态的流程实例。

规则：

1. 只允许对 `running`、`exception`、`suspended` 状态实例执行。
2. 终止后实例状态进入 `terminated`。
3. 所有活跃节点实例停止推进。
4. 所有未完成任务置为 `closed`。
5. 不再允许该实例产生新的普通节点实例和任务。

### 10.3 重试自动节点

`重试自动节点` 表示对失败的自动节点再次执行。

规则：

1. 只允许对当前状态为 `exception` 的自动节点实例执行。
2. 重试时沿用原节点输入快照。
3. 重试时沿用原资源绑定和原修订标识。
4. 每次重试都增加 `retryCount`。
5. 重试成功后节点进入 `completed`，实例回到 `running`。
6. 重试失败后节点保持 `exception`。

### 10.4 通知与审计

每次管理员干预都必须：

1. 生成审计事件。
2. 通知当前受影响的任务处理人。
3. 在实例运行历史中生成一条系统可见记录。

## 11. 知识库引用接入边界

V1 的知识库只采用引用接入模式，不在平台内构建独立知识空间。

V1 支持的最小能力边界如下：

1. 根据查询词检索外部知识库内容。
2. 返回引用片段、来源标识和必要的元数据。
3. 按资源权限控制知识库是否可见和可调用。

V1 不包含以下能力：

1. 在平台内维护知识库目录结构。
2. 在平台内编辑知识内容。
3. 在平台内同步完整知识副本。

## 12. 关键不变量

以下规则在整个 V1 实现中必须始终成立。

1. 流程实例永远绑定创建时的流程版本。
2. 已发布流程版本永远只读。
3. 节点输入输出契约不允许在运行期漂移。
4. 自动节点的重试不得切换到不同资源修订标识。
5. 退回和跳转都不得删除历史节点记录。
6. 管理员干预不得绕过审计。
7. 用户只有在同时满足应用访问、角色授权、节点授权和资源调用授权时才能调用资源。

## 13. 最小验收场景

研发和测试至少要以以下场景验证实现是否符合产品定义。

1. 系统管理员审批新用户并分配平台角色，用户成功登录。
2. 应用管理员创建应用、角色、成员和资源目录。
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

## 14. 开发顺序建议

为了尽快形成可跑通的最小闭环，推荐采用以下实现顺序。

1. 身份、平台角色、应用、应用角色、成员授权。
2. 资源目录和资源授权。
3. 流程定义、版本发布、节点契约校验。
4. 流程实例、节点实例、单人任务流转。
5. 会签、串签、转交、加签。
6. 自动节点、失败处理、管理员干预。
7. 审计、运行监控、通知。

这个顺序的目标是先打通最小流程闭环，再叠加复杂动作和治理能力。
