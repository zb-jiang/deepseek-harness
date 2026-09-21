# Agent Note: Task Multi-Instance Unification (ServiceTask / DSH Backend Task)

Status: implemented

[English](2026-09-15-task-multi-instance.md) | 中文

## 问题

多实例此前是 userTask 专属能力，两个自动节点各自缺一块：

- 普通 ServiceTask（定制 delegate）想按"一个数组变量逐元素跑一份实例"——100 张发票各识别一遍、逐条记录 enrichment——只能在 Java 里自己写循环。画布上还留着计数形式（`loopCardinality`），它把同一个 delegate 原样跑 N 遍、没有任何逐实例输入；标准循环（重做）图标也还在，尽管 DSH 任务节点从不支持重做。
- DSH backend task 只能绑一个 backend profile，"3 个 AI 各评审一遍、2 票通过即走"要摆三个画布节点再加网关接线。[会签计票](2026-09-15-voting-rule.zh.md)也只在 userTask 提交路径上计数，自动节点没有投票通道。

设计文档：`docs/plans/2026-09-14-dsh-backend-task-design.md`（backend task 多实例）、`docs/plans/2026-09-15-voting-rule-design.md`（计票统一）。

## 决策

多实例在三种任务节点上统一，只有份数来源不同：

- **UserTask**——份数 = 候选角色成员数，引擎注入 `dsh_candidates_<taskId>`（不变；计票路径见计票 Note）。
- **普通 ServiceTask**——只支持集合形式：`flowable:collection` 填一个已声明的 `array` 上下文变量（实例数 = 数组长度），`flowable:elementVariable` 填逐实例注入的元素变量名，delegate 用 `execution.getVariable(...)` 读取。元素变量不得与已声明上下文变量重名（实例内会遮蔽流程变量）。普通 service task 配 `loopCardinality` 被发布校验拒绝。
- **DSH backend task**——计数形式：`loopCardinality >= 1` 加 `dsh:backendTask` 下的 `dsh:backendProfile` 列表；第 i 个实例调第 i 个 profile URL（`DshBackendTaskDelegate` 读 `loopCounter` 本地变量）。列表行数必须等于 cardinality，单实例属性 `backendProfileUrl` 与列表不能并存。发布校验（`validateServiceTaskMultiInstance`）管两种形态；`validateBackendTasks` 逐行查 profile 注册表。

标准循环对所有任务节点移除：画布 replace-menu filter 对 UserTask 与 ServiceTask 删除循环入口，发布校验对两者都拒绝 `standardLoopCharacteristics`（userTask 原已覆盖）。

`dsh:votingRule` 扩展到自动节点——同样四个属性，新增两种票源和一个计数点：

- **DSH backend task**：票 = delegate 输出映射写入的表决变量，由下述共享 end listener 计数。
- **普通 ServiceTask**：票 = delegate 代码 `setVariable` 写入的（已声明）表决变量，同一个 listener 计数。
- **userTask**：不变——提交时在 `DshTaskCompletionService` 计数。

`DshBpmnParseHandler.attachServiceTaskVoting` 给每个配了 votingRule 的 service task 挂 end ExecutionListener（`DshVotingEndListener`），并生成与 userTask 相同的完成条件。listener 按本实例表决值累加命中计数，首次触碰时把计数创建为 0。service task 不能沿用 userTask 的 start 时初始化（`DshMultiInstanceSetupListener`）：service task 实例创建与完成交错——同步时同一命令内逐实例贯穿执行，异步时各自 job——start 路径的初始化会把已累加的计数重置回 0。完成条件只在每实例完成后求值，且 Flowable 保证 `callActivityEndListeners` 先于 `completionConditionSatisfied`，所以 listener 既在首次求值前建好变量，也让本实例的票对本次求值可见。

画布：service task 隐藏社区 multiInstance 组；DSH 面板提供「多实例(集合)」组（collection 下拉限定已声明的 array 变量、elementVariable 文本框、配了 votingRule 时隐藏完成条件），backend task 把单个 profile 下拉换成 profile 列表，行数驱动 `loopCardinality`。「会签计票」组出现在三种任务节点上，表决变量选项按类型取数（user/backend task 取映射 target，普通 service task 取已声明上下文变量）。

## 备选方案

**普通 service task 用计数形式多实例。** 画布原本就暴露 `loopCardinality`，它对 backend task 也是正确形态，但放在普通 service task 上只是把 delegate 原样跑 N 遍、没有任何逐实例输入——循环没有可变的东西。发布校验直接拒绝，不留静默空转。

**backend task 用集合形式多实例。** 复用 service task 的集合形态会逼着作者先声明一个装 profile URL 的 array 上下文变量，只为承载接线数据。节点上的 profile 列表把逐实例绑定放在一处，引擎读取也不需要变量中转。

**在各 delegate 里自己计票。** 每个 delegate 都要重复计数的读改写和阈值逻辑，不配合的 delegate 会静默丢票。end listener 把计数集中到一处，覆盖所有 delegate 实现。

**靠 `DshMultiInstanceSetupListener` 在 activity start 时初始化计数。** 对 userTask 有效——实例在等待状态前一次性全部创建；放到 service task 上同一 listener 逐实例触发，会把累加的计数清零。首次计票时惰性创建没有这个时序约束。

## 后果

backend task 的 profile 列表把实例绑定按固定顺序写进 BPMN XML；重排行会在重新发布后把实例换绑到不同 profile（契约是 URL，不是行号）。

profile 列表行指向 inactive profile 时运行期按实例失败、进入 `R3/PT1M` 异步重试；发布校验只在发布时查注册表活跃性。

service task 元素变量保持无冲突依赖命名不相交；发布校验拒绝重名，教程说明该名字必须与 delegate 的 `getVariable` 调用一致。
