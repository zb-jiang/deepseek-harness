# Agent Note: Session Identity Context

Status: implemented

[English](2026-09-09-session-identity-context.md) | 中文

## 问题

员工端通过 Supabase 完成认证，但没有任何机制告诉模型"当前登录人是谁"。报销流程的第一个 user task 让员工重复输入自己的姓名和 id，而模型自述的任何身份都是虚构输入，可能静默污染流程变量。工具与 MCP 调用绝不能携带身份作为鉴权依据，所以方案必须把模型可以"知道"的展示身份与真正鉴权的调用层凭据分开。

这是企业身份传递设计的层 1：给助手一个可靠、新鲜、仅用于展示的当前登录人声明。

## 决策

新增企业包 `@deepseek-ai/dsh-user-identity-context`，同时拥有身份缓存与模型可见注入。

`ctx.currentUser`（`CurrentUserService`）在内存中记住最近一次验签通过的平台用户。缓存由两个 emit 事件驱动，事件声明在 `@deepseek-ai/dsh-platform-user` 接口包上、由 `platform-user-api` 发射：`platform-user/verified` 在每次验签成功的 `GET /api/enterprise/auth/me` 响应后发出，`platform-user/signout` 在新的 `POST /api/enterprise/auth/signout` 触点上发出。插件以全局监听订阅这两个事件；插件缺失时事件发入虚空，API 路由缺失时存储保持为空。

注入监听 `agent/pre-step`（前置注册），在每轮 turn 的 step 1 追加一条 `<user_identity>` 快照 user 消息：一条插件归属消息（`form: 'snapshot'`、单 section），固定文案携带显示名、邮箱、userId 以及纪律行——仅用于展示，鉴权留在调用层凭据。reject 决策与已中止的 step 原样通过，存储为空时不注入任何内容。同一轮的后续 step 不重复该块；重新登录从下一轮起生效。

包自有的 invariant 伴随插件（`./invariant`，与 time-context 同机制）固定块的确切格式、非空字段、会话位置（必须在未关闭的 turn 与 step 内、`request/header` 之前），以及消息 source 只携带确切快照文本——持久日志不会积累被篡改的身份块。

`ui-enterprise` 的切换账号在清除本地 token 之前先通知 signout 触点，使 webserver 缓存在同一动作中忘记该身份。

仅由 `enterprise-app` bundle patch 注册；不改变任何默认 profile。

## 落选方案

**系统提示词 section。** prompt section 按请求装配，但每轮模型上下文的既有持久机制是带 invariant 校验与 section 归属的插件快照消息（time-context 先例）；prompt section 会绕开这套词汇并让 invariant 故事复杂化。

**通过工具或 MCP 参数传递身份。** 这会让模型成为身份传输通道：伪造或注入的值在工具边界与真实值无法区分。因安全原因否决；身份块中的纪律行明确禁止。

**在 `platformUsers` 接口内部观察（包装 `getUserByToken`）。** 每次 token 读取（而非仅显式认证触点）都会改动缓存，且缓存将依赖 provider 内部实现。触点事件让观察保持显式。

**从 `platform-user-api` 硬依赖本插件。** 这会迫使纯认证表面加载 `agents` 服务，并把两个各自独立有用的包耦合起来。

## 后果

每轮多付出一条约四行的 user 角色消息。身份反映最近一次验签触点；token 在会话中途过期时，最后一次验签身份会保留到下一个触点——同一人类的陈旧窗口，因身份块仅用于展示而良性。webserver 重启后在客户端下一次 `/me` 时重建缓存。

层 2——把调用层凭据传递给工具与 MCP——仍是鉴权路径，不在本篇范围内。

## 测试

包内测试套件固定注入时机、每轮节奏、reject/中止透传、事件接线与 loader 导出路径；invariant 套件固定格式、位置、来源归属与迟到注册校验。`platform-user-api` 套件固定成功时的 `platform-user/verified` 发射、失败时不发射、signout 路由的 204 与事件。

## 未决

该模型可见行为变更还没有 keyless 的装配应用快照；enterprise profile 示例的快照测试设施仍是待办。
