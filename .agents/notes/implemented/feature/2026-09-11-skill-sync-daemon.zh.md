# Agent Note: 企业 skill-sync 分发守护进程

状态: 已实现

[English](2026-09-11-skill-sync-daemon.md) | 中文

## 问题

BPMN user task 以裸 `dsh:skillRef` 名引用企业 skill,但员工端 DSH 无法获取这些 skill:只能手工复制到 `%USERPROFILE%\.dsh\skills\` 且从不更新(skill-repo-design §2)。服务端已有 SkillHub 作为企业仓库,flowable-engine 知道用户必须办理哪些任务,缺的是两者与员工缓存之间的分发通道。

## 决策

[skill-repo 设计](../../../../../docs/plans/2026-09-09-skill-repo-design.md)持有四工作项框架;本 note 记录工作项 2 的实现。flowable-engine 暴露 `GET /dsh/skills/required`(JWT `sub` 是唯一身份入参),聚合两个来源:活跃待办 `dsh_node_meta` 的 skillRefs,以及全部最新已部署定义的静态扫描——用户的角色集合(按 `auth_subject` 反查 `public.app_memberships`)命中 userTask 的候选角色或超时升级目标即计入。返回的每个 skill 携带 SkillHub namespace,经 `public.workflow_definitions.published_procdef_id` JOIN 应用表的 `skillhub_namespace` 解析——定义级 app 归属只存在 web-console 的表里,而引擎已共享同一 Supabase PG。

新企业插件 `@deepseek-ai/dsh-skill-sync` 持有员工端。一个注册在 `$DSH_HOME/skill-sync/skills` 上的 `FileSystemSkillProvider` 实例(不含默认根、不 watch)供给 `ctx.skills`;守护定时器持登录员工的 Supabase JWT 调 `/dsh/skills/required`,将 namespace 清单与本地指纹状态文件 diff,把缺失/过期的 SkillHub zip 下载到临时目录后原子改名,再调 `control.invalidate()` 让注册表重建。`ctx.skillSync.ensureInstalled(names)` 按需执行同一同步,供待办打开路径使用(工作项 3)。原始 access token 经现有 `platform-user/verified` 事件进入 `CurrentUserService.getToken()`,后台消费者以登录员工身份行动;token 不进入模型上下文。

## 备选方案

**在 skill-sync 插件持久化员工 token。** 第二个凭据存储会复制身份层;store 已观察每次验证过的 `/me`,复用它让每次登录只有一个 token 生命周期。

**经 flowable-engine 解析下载 URL。** 引擎将代理 SkillHub,增加设计禁止的一跳(§9 要求 skill-sync 直连 SkillHub),并让引擎代码耦合注册中心 DTO。

**watch 缓存根目录。** 插件自身原子安装,装后显式 `invalidate()` 是确定性的;watcher 会在 Windows 上引入 chokidar 轮询而无额外触发点。

## 后果

一个 skill 在员工会话可用,前提是 namespace 已绑定到应用(web-console 设计)、引擎能经最新 `published_procdef_id` 把定义映射到该 namespace、且 SkillHub token 属主是该 namespace 成员——重新发布工作流或移除 token 属主的成员资格后,相关 skill 只会记日志警告并在下一轮前跳过。旧流程实例在结束前继续解析到重新发布前的 namespace。失败不阻塞员工端启动:未登录轮次跳过,下载失败在下一 interval 重试。单测以 stub fetch 覆盖守护与安装路径;工作项 3(待办打开即装)将由任务工作台调用 `ensureInstalled`。
