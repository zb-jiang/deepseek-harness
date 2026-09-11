# Agent Note: 待办打开即时安装 skill

Status: implemented

[English](2026-09-11-skill-on-open-ensure.md) | 中文

## Problem

工作项 2 的 daemon 按周期预装 skill，但员工可能在下一个 tick 之前——甚至首轮同步之前——就打开待办，会话将在缺失引用技能的状态下启动（skill-repo-design §7）。`dshMeta.skillRefs` 到达 Web UI 后只是一个有类型但无人消费的字段，而 `ctx.skillSync.ensureInstalled` 只是进程内调用面，浏览器没有触达员工端服务的通路。

## Decision

由 skill-sync 自己服务桥接端点 `POST /api/enterprise/skills/ensure`（与 `/api/enterprise/auth` 平行的前缀路由——enterprise 插件的既有模式，不涉足 Typert/RPC 面）。handler 对每个传入名字先按 skill 裸名字符集校验（名字会直接拼进缓存目录路径），再调 `ensureInstalled`，返回一轮即时同步后仍缺失的名字。同一份 sync 加了并发门：daemon/登录/端点触发并发到达时合并为同一轮进行中的同步，双击待办或 tick 恰落在安装中途都不会交叉两轮下载或 state 写入。

`EnterpriseWorkbench.openTask` 在解析会话绑定前等待 ensure 步骤。已就绪的 skill 让该步骤退化为纯本地目录检查（无出站请求）；缺失则跑一轮即时同步，期间侧栏显示准备提示并禁用待办按钮。同步后仍缺失——或请求失败——记入 `skillNotice` 后会话照常打开，即设计好的降级模式：AI 会话继续，只是 `skill` 工具调不到该技能。无 `skillRefs` 的任务完全跳过往返。

## Alternatives considered

**复用 Typert `/api` JSON-RPC 网关。** 那是 DSH 核心会话/工作区控制器的通道；enterprise 插件从未注册过，webserver 前缀路由以不动核心面为前提交付同等能力。

**失败时向会话注入系统消息（§7 原文写法）。** `IConversation` 客户端公开面没有追加系统消息的入口，为企业文案开一个就跨越了「不改核心」的边界。侧栏提示行（既有 `prefillNotice` 模式）已可见承载失败；重试即再次点击待办——每次打开都重查。

**阻塞会话直到技能装完。** 设计要求缺技能也会话继续；硬门会把 SkillHub 故障变成员工完全打不开待办。

## Consequences

每次打开待办都在本地重查，缓存被清空后即使 daemon 停用也能在下一次打开时自愈。端点未鉴权但无登录时无害：`ensureInstalled` 查不到东西，sync 轮无 token 直接跳过，只返回目录存在性答案。提示行刻意比准备标志存活更久（打开无 skillRefs 任务时清除），让员工在会话中途也知道技能为什么缺失。单元测试钉住端点的 200/400/404 路径、合并后的单轮同步，以及 Web UI 依赖的 missing 名单契约。
