# Agent Note: DSH Backend Task and Backend Profile

Status: implemented

[English](2026-09-14-dsh-backend-task-and-profile.md) | 中文

## Problem

企业流程需要完全无需人工参与的 AI 生成环节。DSH user task 已经具备正确的语义——userPrompt（`{{var.field}}` 插值）、引用的 skill、输出映射到流程上下文变量——但每个环节都要求一个人打开任务对话、确认 AI 输出、提交变量映射。定时或批处理型流程（夜间报表、自动化数据补全）没有对应能力：普通 service task 没有 prompt/skill/mapping 词汇，而 headless delegate 每次调用都拉起一次性进程，没有常驻工作空间和 skill 状态。

设计文档：`docs/plans/2026-09-14-dsh-backend-task-design.md`。

## Decision

DSH backend task 是画布上的独立节点：一个 ServiceTask，带 `dsh:backendTask backendProfileUrl=...` 扩展元素，并复用 user task 的 userPrompt/skillRef/outputMappings 扩展。web-console 的 palette 在一次命令栈操作里写入 `delegateExpression=${dshBackendTaskDelegate}`、`async=true`、`failedJobRetryTimeCycle=R3/PT1M`；属性面板提供从实时注册表取数的 profile 下拉，prompt/skill/映射编辑器与 user task 复用。它没有候选角色、超时升级、SoD——没有人工环节，这些语义无从谈起。多实例随 [2026-09-15 任务多实例 Note](2026-09-15-task-multi-instance.zh.md) 加入：`loopCardinality` 加 `dsh:backendProfile` 列表，第 i 个实例绑第 i 个 profile URL。

对端是 backend profile：一个常驻 DSH 实例，用 `dsh --profile enterprise-backend` 启动（bundle `packages/bundle/enterprise-backend`，插件 `packages/enterprise/backend-task`），工作空间与 LLM 配置独立。它启动时向 web-console 注册并以 heartbeat 维持（`POST /api/backend-profiles/register`），每个提交来的任务跑一次非交互 agent 会话，并周期同步 `backendProfileUrl` 指向自己的 backend task 所引用的 skill——这是员工端 [skill-sync daemon](2026-09-11-skill-sync-daemon.zh.md) 的服务端对应物。多个实例可以并存；URL 存在节点上，选哪个实例是流程设计决策。

注册表在 web-console：`backend_profiles` 表（按 URL upsert；heartbeat 超过 5 分钟视为 inactive）、从 `workflow_definitions.published_bpmn_xml` 快照做 skill 归属聚合（解析 `dsh:backendTask@backendProfileUrl`，聚合该节点的 skillRefs）、发布校验（`validateBackendTasks`：URL 非空且已注册、delegate/async 绑定、prompt 引用、映射 target、skillRefs）。

引擎 delegate 闭环：`DshBackendTaskDelegate` 用与 user task 相同的 `DshPromptInterpolator` 插值 prompt，经 `DshBackendClient` 提交（POST 建任务 → 轮询 GET 直到 ready/failed/超时），结果 JSON 经公共的 `DshVariableMappingSupport` 写入流程变量。根路径 array target 整体写入——不做 append 聚合，因为自动节点一次执行就产出完整结果；深路径 target 按变量字段清单里叶子字段的声明类型转换。任何失败——HTTP、超时、任务 failed、JSON 非对象、映射违规——都抛给 async job 走 `R3/PT1M` 重试周期。

profile 契约只走代码级 HTTP（`/api/backend/tasks`），不用 CLI 提交 prompt。

## Alternatives considered

**给 user task 加「无人工」开关。** 多实例、候选角色、超时升级、SoD 语义全都要条件性抑制，完成与 listener 路径都要按开关分支，员工端任务列表也要过滤。独立节点类型让 human task 的产品语义保持原样。

**像 `DshHeadlessClient` 一样每次调用拉起 headless 进程。** 一次性进程没有常驻工作空间、没有预同步的 skill、也没有可访问的 HTTP 端点；每次调用都要重新做 skill 发现。backend profile 常驻正是为了让工作空间和 skill 保持热态，多个不同 URL 的实例也能共用一台服务器。

**推结果而不是轮询。** 回调要求 profile 能反向访问引擎并关联流程实例 id；轮询让 profile 对调用方保持无状态，profile 重启也不影响。内存任务表可以接受，因为引擎的 async job 重试覆盖了丢任务的情形。

## Consequences

profile URL 写死在 BPMN XML 里：profile 换地址意味着修改指向它的流程并重新发布。

profile 的任务表是进程内存态；重启会丢运行中的任务。引擎的重试周期是恢复路径，所以 profile 重启应明显快于 `R3/PT1M` 的节奏。

注册是全局的——任何 backend task 都可以指向任何已注册实例；按应用绑定注册表、服务账号登录（让知识库工具进入 backend 会话）都是后续项。

prompt 插值与输出映射语义现在是 user task 与 backend task 两条路径的共享代码，改 `DshPromptInterpolator` 或 `DshVariableMappingSupport` 会同时作用于两者；引擎测试套件同时钉住两个消费方。
