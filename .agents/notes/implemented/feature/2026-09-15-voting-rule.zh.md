# Agent Note: 会签计票规则 (dsh:votingRule)

Status: implemented

[English](2026-09-15-voting-rule.md) | 中文

## 问题

多实例会签的完成条件只能数"完成了几份"，不能感知每份的表决结果。"5 人中 3 人同意"写成 `${nrOfCompletedInstances >= 3}`，1 人同意 2 人拒绝（3 份完成）也照样收工。更糟的是每份提交都覆盖同一个结果变量，下游网关只能看到"最后一个人"的值——连 `${rejected}` 一票否决都会在拒绝先提交、同意后提交时失效。按结果计票必须在提交路径上做聚合；任何纯建模组合都凑不出来。

设计文档：`docs/plans/2026-09-15-voting-rule-design.md`。

## 决策

userTask 可携带 `dsh:votingRule` —— `variable`（本节点输出映射 target 之一）、`passValue`（等于它记同意票；非空且不等记否决票）、`passCount`（同意票提前收阈值）、可选 `rejectCount`（否决票提前收阈值）。机制与现有候选人注入同构：与 `dsh_candidates_<taskId>` 一样，计票变量 `dsh_passCount_<taskId>` / `dsh_rejectCount_<taskId>` 是上下文声明面之外的运行时注入变量。

自 2026-09-15 起该规则同样适用于普通 ServiceTask 与 DSH backend task——属性相同，票源不同，计数走 listener 路径，由[多实例 Note](2026-09-15-task-multi-instance.zh.md) 记录。本 Note 描述 userTask 路径。

三层协作（userTask 路径）：

- **部署时**（`DshBpmnParseHandler`）：带 `votingRule` 且未手写完成条件的多实例 userTask，自动生成完成条件 `${dsh_passCount_<id> >= P}` 或 `${dsh_passCount_<id> >= P || dsh_rejectCount_<id> >= R}`（同一条件生成也覆盖配 votingRule 的 service task）；手写条件永不覆盖（纵深防御；发布校验前置拒绝矛盾组合）。
- **节点 start 时**（`DshMultiInstanceSetupListener`）：多实例拆分前把两个计数初始化为 0。这一步是硬性的——生成的完成条件在第一份实例完成时就会求值，变量缺失 JUEL 抛 "Unknown property"。listener 挂载条件从"有 candidateRoleId"放宽为"有 candidateRoleId 或有 votingRule"。
- **提交时**（`DshTaskCompletionService`）：声明校验之后、`complete()` 之前，读原始提交 Map 的表决变量，字符串化后与 `passValue` 比较，命中的计数 +1。值缺失（员工清空了映射）不计票也不阻断。聚合放在校验之后意味着被拒的提交在重试时不会重复累计。

发布校验（`validateVotingRules`）：必填属性与整数阈值、`variable` 必须在本节点输出映射 target 中、必须配多实例、与手写 `completionCondition` 并存拒绝。条件表达式引用检查按 `dsh_candidates_` / `dsh_passCount_` / `dsh_rejectCount_` 前缀豁免运行时注入变量，网关可直接按计数路由。

画布：userTask DSH 面板新增「会签计票」组（表决变量下拉，选项=本节点映射 target）；配置 `votingRule` 后，内置多实例组在已隐藏的 `loopCardinality` 之外同时隐藏 `completionCondition`。

## 备选方案

**提交快照列表。** 把每份提交的 variables append 进 `dsh_submissions_<taskId>` 列表，由下游脚本/delegate 数票。无新 schema，但数票变成定制代码，且"3 票同意提前收"做不到——完成条件仍只数完成数。

**让完成条件学会数结果。** Flowable 的 `nrOfCompletedInstances` 家族是引擎内置；没有按结果分组的计数器，实例局部变量在实例 execution 结束后就消失。

## 后果

并行提交在计数读改写上存在竞态；Flowable 乐观锁让后到事务变成客户端可重试的错误。作为已知风险记录，未解决。

`passCount` 大于角色成员数时永不提前收——实例集自然结束，网关按最终计数路由，语义仍正确。

表决值在字符串化后比较，`true`（Boolean）匹配 `passValue="true"`；比较对 JSON 标量类型是刻意宽容的。
