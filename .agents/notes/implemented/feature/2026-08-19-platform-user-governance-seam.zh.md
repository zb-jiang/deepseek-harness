# Agent Note: Platform-User Governance Seam

Status: implemented

[English](2026-08-19-platform-user-governance-seam.md) | 中文

## Problem

DeepSeek Harness 目前已经有面向遥测的匿名身份，但企业平台能力需要在已认证 subject 之上再叠一层受治理的用户记录：待审批、平台角色、禁用或锁定，以及恢复。如果把这些规则直接写进某个 Web 页面或单个 API 路由，其他宿主无法复用，而且也会绕开仓库里“新增产品行为必须挂到已文档化 seam 上”的规则。

## Decision

企业平台先从一条独立的 identity 组 seam 开始：`@deepseek-ai/dsh-platform-user`，挂载为 `ctx.platformUsers`。

这条 seam 拥有的是 Harness 侧治理记录，而不是登录握手本身。外部身份后端继续负责认证、会话签发、密码重置和 SSO。seam 接收一个已经创建好的 auth subject，并治理对应的平台用户记录：注册进入 `pending_approval`、带平台角色审批、变更角色、禁用、锁定、恢复，以及按平台用户 id 或 auth subject 查询。

第一个 provider 是 `@deepseek-ai/dsh-platform-user-supabase`。它注册到 `ctx.platformUsers`，把每个 auth subject 对应的一条治理记录存进 Supabase 表，在存储边界校验每条数据行，再把存储行映射成 seam 稳定的 `PlatformUser` 值。

这个拆分遵循现有 capability 模式：一个包放 Service Definition，另一个包放后端 provider，后续再在它之上挂 API 和 Web consumer。

## Alternatives considered

**把平台用户规则直接放进 Web 或 API 层。** 这样对单一界面会更快，但无法形成可复用的产品能力，会让不同宿主重复治理规则，也违背仓库里“新增行为应挂到已文档化扩展点”的规则。

**把平台用户治理塞进 `identity/anonymous-user-id`。** 那个包只拥有限定于 harness-home 的匿名关联 id。把企业用户记录混进去，会把匿名遥测身份和认证治理状态混在一起，也会让一个简单工具包承担无关 seam。

**让 Supabase 直接成为 seam，而不是第一个 provider。** 这样会把产品词汇直接绑到单一后端。现在的 seam 用 `PlatformUser` 记录和治理命令说话，这样以后即使换 provider，也不需要重写 consumer。

## Consequences

identity 组现在同时包含匿名身份和企业治理两条能力线。

后续 API、host 和 Web 工作将消费 `ctx.platformUsers`，而不是各自拥有审批和角色规则。

Supabase 是这条能力的第一个后端，但不是产品边界本身。
