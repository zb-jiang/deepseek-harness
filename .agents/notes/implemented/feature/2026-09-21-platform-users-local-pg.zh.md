# Agent Note: 平台用户迁本地 PostgreSQL

Status: implemented

[English](2026-09-21-platform-users-local-pg.md) | 中文

## 问题

全部治理元数据存放在 Supabase Postgres,走国际网络路径。该路径的 DNS 解析失败与延迟抖动会拖垮 Web Console 后端:JDBC 调用卡死在 socket 读,Hikari 连接池耗尽,前端所有请求在 30s axios 上限处超时而后台无任何日志。员工端 provider 还在放大暴露面——通过 RLS 自读策略直连 Supabase PostgREST 读 `platform_users`。

## 决策

企业部署把全部数据库存储迁到本地自管 PostgreSQL,Supabase 收缩为两个服务:Auth(JWT 签发,各组件经 JWKS 本地验签)与 Storage(知识库文件)。

- `SUPABASE_DB_HOST`/`SUPABASE_DB_USER`/`SUPABASE_DB_PASSWORD` 变量名不变,值改指本地实例;Web Console 后端与 Flowable 引擎的消费代码不动。
- Supabase `auth.users` 上的 `platform_users` 注册 trigger 不复存在。Web Console 的 `JwtAuthConverter` 改为在 JWT 验证时对无记录用户 JIT 插入 `pending_approval` 行:要求 JWT `email` claim,`login_name`/`display_name` 优先取 `user_metadata`,缺省兜底 email 与 email 本地部分(即原 trigger 的 COALESCE 分支),id 走 `gen_random_uuid()` 默认。email claim 缺失维持无权限 principal 降级路径。
- 员工端 provider `@deepseek-ai/dsh-platform-user-supabase` 删除。替代者 `@deepseek-ai/dsh-platform-user-console` 用 JWKS 本地验 JWT,再携带用户 bearer token 从 Web Console 后端(`GET /api/users/me`)读取治理记录。bundle patch 只换 provider 注册,`ctx.platformUsers` 的消费方零改动。
- 浏览器登录(`platform-user-api` 经 supabase-js + anon key)与知识库 Storage 透传仍走 Supabase。`kb-*` 桶的 Storage 策略放宽为"按桶前缀放行 authenticated 读写":原策略引用的治理表已迁本地,在 Supabase 内无法存在。逐用户可见性由 Web Console 后端元数据层执行,所有 Storage 调用都经该后端,登录用户直连 Storage 是唯一放宽面,作为权衡接受。

## 备选方案

**保留 Supabase 存储,客户端侧加 JDBC 快速失败参数。** 超时能缓解,但共享国际路径仍是持续故障源,且每条查询都付远端 RTT。

**员工端直连本地数据库。** 这会把数据库凭据分发到每台员工 PC,并为一次单行读取重新引入逐客户端的连接管理,而 Web Console 已在同一端点服务该读取。

**Supabase Auth webhook 预建档。** 需要公网入口与密钥托管才能达到 JIT 在既有验证点免费获得的效果。

## 后果

平台列表页与流程操作不再依赖国际网络路径,列表查询回到本地时延。

系统管理员的运维面拆为两份手册:精简后的 Supabase 配置指南(项目、Auth、Storage)与本地 PostgreSQL 配置指南(安装、建表、环境变量、`platform_users` 一次性迁移)。

JIT 建档只覆盖携带 email claim 的登录;匿名或仅手机号用户与以前一样降级(无记录、无角色)。
