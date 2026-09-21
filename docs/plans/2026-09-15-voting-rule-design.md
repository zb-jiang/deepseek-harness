# 会签计票（dsh:votingRule）设计

> 状态：实施完成——组 1-5 全部落地（引擎 34/34、web-console 校验 26/26 单测通过；前端 tsc 由用户手工验证）。已知风险见 §6。
> 扩展（同日）：计票已统一到三种任务节点（普通 ServiceTask 与 DSH backend task 支持 votingRule），见 §9；多实例本身的三节点统一见 `2026-09-14-dsh-backend-task-design.md` §13。
> 关联：`2026-09-01-process-context-design.md`（输出映射）、`2026-08-24-bpmn-components-tutorial.md`（多实例章节）、CLAUDE.md「Human task 待办产品语义」

## 1. 背景与问题

多实例会签的完成条件目前只能数"完成了几份"（`nrOfCompletedInstances`），不感知每份的表决结果：

- 业务需求"5 人中 3 人同意才通过"：写成 `${nrOfCompletedInstances >= 3}`，则 1 同意 2 拒绝（完成 3 份）也提前收工——**与业务语义不符**。
- 结果变量互相覆盖：每份提交写同一个流程变量（如 `approvalResult`），后提交覆盖先提交；网关/脚本只能读到"最后一份"的结果，无法数票。
- 结论：**按结果计数的会签必须在提交路径上做聚合**，纯建模无解。

## 2. 需求语义

以"5 人中 3 人同意才往下走"为例：

| 局面 | 期望行为 |
| --- | --- |
| 凑满 3 票同意 | 提前结束多实例，剩余待办自动删除（与 single 语义同构） |
| 1 同意 2 拒绝（未达任何阈值） | 继续等剩下的人投 |
| 达到否决票数（可选配置） | 提前结束（如 2 票拒绝直接判拒） |
| 全员投完仍未达通过票数 | 自然结束，由后续网关按票数路由拒绝分支 |

## 3. 方案总览

新增 `dsh:votingRule` 扩展（userTask 级，与 `dsh:assignmentRule` 平级）声明计票规则；引擎在**每次实例提交**时聚合票数、部署时**自动生成**完成条件，网关读聚合计数变量路由。三层与现有机制同构：

- 候选角色 → `dsh_candidates_<taskId>`（运行时注入，引擎补 collection/elementVariable/assignee）
- 表决结果 → `dsh_passCount_<taskId>` / `dsh_rejectCount_<taskId>`（每次提交累加）
- 完成条件 → parse 时自动写入 `${dsh_passCount_x >= P || dsh_rejectCount_x >= R}`

## 4. 详细设计

### 4.1 BPMN 扩展（dsh:votingRule）

```xml
<userTask id="approveTask" name="费用专员会签">
  <extensionElements>
    <dsh:assignmentRule candidateRoleId="..."/>
    <dsh:votingRule variable="approved" passValue="true" passCount="3" rejectCount="2"/>
  </extensionElements>
  <multiInstanceLoopCharacteristics isSequential="false"/>  <!-- 完成条件由引擎生成 -->
</userTask>
```

| 属性 | 必填 | 说明 |
| --- | --- | --- |
| `variable` | 是 | 表决变量名，必须是本节点输出映射 target 之一（员工端提交映射写入） |
| `passValue` | 是 | 什么值算同意票（如 `true`、`approve`）；非空且不等于 passValue 即否决票 |
| `passCount` | 是 | 通过票数阈值，达到即提前收 |
| `rejectCount` | 否 | 否决票数阈值，达到即提前收；缺省=不设否决阈值（否决票仍计数，供网关路由） |

计票规则：提交值 == passValue → 同意 +1；提交值非空且 != passValue → 否决 +1；值缺失/null（员工在映射对话框清空了该映射）→ 不计票，不阻断提交。

### 4.2 画布（web-console 前端）

- `dsh-moddle.ts`：新增 VotingRule 类型描述（属性 variable/passValue/passCount/rejectCount，allowedIn UserTask + ServiceTask，见 §9）。
- `DshPropertiesProvider` userTask DSH 组新增「会签计票」折叠配置：表决变量（下拉，选项=本节点输出映射 target 根变量）、通过值、通过票数、否决票数（可空）。
- 配了 votingRule 时隐藏 Multi-instance 组的 Completion condition 输入框（与已隐藏的 loopCardinality 同机制）——完成条件由计票规则拥有，源头杜绝矛盾配置。

### 4.3 发布校验（web-console BpmnValidationService）

新增 `validateVotingRules`：

1. votingRule 各必填属性非空；passCount 为 >=1 整数；rejectCount 缺省或 >=1 整数。
2. `variable` 必须在本节点输出映射 target 根变量中。
3. votingRule 节点必须配多实例（并入现有 assignmentRule wiring 校验同段）。
4. votingRule + 手写 completionCondition 并存 → 报错（完成条件由引擎按计票生成，手写会被覆盖语义冲突）。
5. 条件表达式引用存在性校验按**前缀豁免**运行时注入变量：`dsh_candidates_*` / `dsh_passCount_*` / `dsh_rejectCount_*`（网关条件直接引用计数变量路由；现有 BUILTIN_IDENTIFIERS 是精确名单，需加前缀匹配）。

### 4.4 引擎：解析与自动完成条件（flowable-engine）

- `DshBpmnExtensionParser` / `DshExtensionProperties`：解析 VotingRule（variable/passValue/passCount/rejectCount），与 assignmentRule 同构。
- `DshBpmnParseHandler.attachMultiInstanceSetup` 同位置扩展：配了 votingRule 且未手写完成条件时，写入计票完成条件：
  - 有 rejectCount：`${dsh_passCount_<id> >= P || dsh_rejectCount_<id> >= R}`
  - 无 rejectCount：`${dsh_passCount_<id> >= P}`
  - 手写完成条件时不覆盖（发布校验已拦矛盾配置，此处是纵深防御）。
- 完成条件满足时 Flowable 原生删除剩余活动实例——提前收语义与 single 一致，无新代码。

### 4.5 引擎：提交聚合（DshTaskCompletionService）

员工端 `/dsh/tasks/{id}/complete` 现有路径（解析扩展 → 映射 → taskService.complete）中，在 complete 之前插入聚合：

1. resolveTaskProperties 拿 votingRule；无则走现有路径。
2. 从**本次提交的 variables Map**（映射后、写流程前）读 `variable` 值，按计票规则判定同意/否决。
3. 累加流程变量 `dsh_passCount_<taskId>` / `dsh_rejectCount_<taskId>`（首次初始化为 0）。
4. 完成 complete；引擎在实例完成时求值 4.4 生成的完成条件，读到刚累加的计数。

计数变量为运行时注入，不要求在 contextVariables 声明，不进入发布校验声明面。

### 4.6 网关路由示例

```xml
<exclusiveGateway id="decide"/>
<sequenceFlow id="pass" sourceRef="decide" targetRef="...">
  <conditionExpression xsi:type="bpmn:tFormalExpression">${dsh_passCount_approveTask >= 3}</conditionExpression>
</sequenceFlow>
<sequenceFlow id="reject" sourceRef="decide" targetRef="...">
  <conditionExpression xsi:type="bpmn:tFormalExpression">${dsh_passCount_approveTask < 3}</conditionExpression>
</sequenceFlow>
```

## 5. 场景走查（5 人角色，passCount=3，rejectCount=2）

| 提交序列 | 计数 | 行为 |
| --- | --- | --- |
| 同意、同意、同意 | pass=3 | 第 3 份提交后完成条件满足，提前收，剩余 2 条待办自动删除，网关走通过分支 |
| 同意、拒绝、拒绝 | reject=2 | 达否决阈值，提前收，网关 passCount<3 走拒绝分支 |
| 同意、拒绝、同意 | pass=2, reject=1 | 未达阈值，剩余 2 人继续投 |
| 投满 5 人：2 同意 3 拒绝 | pass=2, reject=3 | 若 rejectCount=2 已提前收；若未配 rejectCount 则投满自然结束，网关走拒绝分支 |
| 某份提交清空了 approved 映射 | 不计票 | 实例照常完成，计数不变 |

## 6. 已知风险

- **并发提交竞态**：并行会签多人同时提交时，计数变量读改写可能丢失更新（Flowable 执行树乐观锁会让后到事务失败，员工端收到错误重提）。真实频率低，本期不解决，记录在案。
- passCount >= 角色成员数时提前收永不触发（等于全员投完），语义仍正确（网关路由兜底），不阻断。

## 7. 工作项清单

### 组 1：画布（web-console 前端）

| # | 工作项 | 验证 |
|---|---|---|
| 1 | `dsh-moddle.ts` VotingRule 描述符 | 导出 XML 对齐 4.1 |
| 2 | DshPropertiesProvider「会签计票」配置（表决变量下拉 + 通过值 + 通过/否决票数） | 手工画布验证 |
| 3 | 配 votingRule 时隐藏 completionCondition 输入框 | 手工画布验证 |

### 组 2：发布校验（web-console 后端）

| # | 工作项 | 验证 |
|---|---|---|
| 4 | `validateVotingRules`（4.3 五条规则） | 单测：各拒绝路径 + 通过路径 |
| 5 | 条件引用校验前缀豁免 dsh_candidates_/dsh_passCount_/dsh_rejectCount_ | 单测 |

### 组 3：引擎解析与自动条件（flowable-engine）

| # | 工作项 | 验证 |
|---|---|---|
| 6 | Parser/Properties 解析 VotingRule | 单测：含边界（缺属性、空值） |
| 7 | ParseHandler 自动写计票完成条件（含/不含 rejectCount、手写不覆盖） | 单测 |
| 8 | DshProcessValidator 豁免确认（自动生成的条件不触发引擎校验错误） | 单测 |

### 组 4：提交聚合（flowable-engine）

| # | 工作项 | 验证 |
|---|---|---|
| 9 | DshTaskCompletionService 聚合计数（4.5） | 单测：同意/否决/缺失三分支 |
| 10 | 端到端：部署含 votingRule 流程 → 3/5 同意提前收+剩余待办删除 → 网关路由；1 同意 2 拒绝继续等；否决阈值提前收 | 引擎内嵌 H2 集成测试 |

### 组 5：文档

| # | 工作项 |
|---|---|
| 11 | 教程会签章节改写（votingRule 用法 + 场景表） |
| 12 | CLAUDE.md「Human task 待办产品语义」补会签计票段 + Agent Note |

## 8. 测试要点

- 解析：votingRule 全属性/缺 rejectCount/缺 variable（校验层拦截，解析层容错）。
- 聚合：提交值==passValue 计同意；非空!=passValue 计否决；缺失不计；首次提交计数从 0 初始化。
- 自动条件：无手写时生成正确表达式；有手写时不覆盖；发布校验拦矛盾配置。
- 端到端走查表（§5）逐行覆盖。
- 校验豁免：网关条件引用 dsh_passCount_* 不报未声明变量。

## 9. 扩展：三种任务节点统一计票（2026-09-15 多实例统一）

多实例统一到三种任务节点后（见 `2026-09-14-dsh-backend-task-design.md` §13），计票同步扩展到自动节点。四个属性、完成条件表达式、计数变量前缀全部复用，只有**票源**和**计数点**不同：

| 节点 | 票源（表决变量由谁写入） | 计数点 |
| --- | --- | --- |
| userTask | 员工提交映射（§4.5 提交端点） | `DshTaskCompletionService`（提交路径，不变） |
| DSH backend task | delegate 输出映射按 `dsh:outputMappings` 写表决变量 | `DshVotingEndListener`（实例 end listener） |
| 普通 ServiceTask | delegate 代码 `setVariable` 写入已声明的表决上下文变量 | 同上 |

### 9.1 引擎（end listener 计数）

`DshBpmnParseHandler.attachServiceTaskVoting`：配了 votingRule 的多实例 ServiceTask（两种自动节点共用）挂 end ExecutionListener（`DshVotingEndListener`）并按 §4.4 同一 `buildVotingCondition` 生成完成条件（手写不覆盖）。

`DshVotingEndListener.notify`：读本实例表决变量，字符串化后与 passValue 比较，累加 `dsh_passCount_<taskId>` / `dsh_rejectCount_<taskId>`；计数变量**首次计票时惰性创建为 0**，缺失表决值不计票不阻断。MI 根执行（body 整体收工触发、无 loopCounter）不重复计票。

不能用 userTask 的 start listener 预置：service task 实例创建与完成交错（同步时同一命令内逐实例贯穿执行，异步时各自 job），逐实例 start 会把已累加的计数重置回 0。完成条件只在每实例完成后求值，且 Flowable 保证 `callActivityEndListeners` 先于 `completionConditionSatisfied`——listener 先行创建即保证变量已存在，本实例的票对本次求值可见。

### 9.2 发布校验

`validateVotingRules` 泛化到三种节点；表决变量存在性按类型取数：

- userTask / DSH backend task：`variable` 必须是本节点输出映射 target 根变量（原规则）。
- 普通 ServiceTask：`variable` 必须是已声明的上下文变量（delegate 写的是流程变量，无映射机制）。

其余规则（必填属性、整数阈值、必须多实例、禁与手写完成条件并存、网关条件前缀豁免）三节点一致。

### 9.3 画布

- 「会签计票」组出现在三种任务节点；表决变量下拉按类型取数：user/backend task 取本节点映射 target，普通 service task 取已声明上下文变量。
- 配了 votingRule 时隐藏完成条件输入（普通 service task 的「多实例(集合)」组与 userTask 的多实例组同机制）。
