# DSH 企业平台 · 分析看板（业务分析 + 运维健康）实施设计

日期：2026-09-25
状态：设计完成，待评审后实施
目标读者：第三方开发团队。本文档自包含：不依赖任何设计会话上下文，读者基于本文档 + 项目源码 + §3 列出的配套文档即可开始开发。

---

## 0. 一句话概述

在 web-console 管理界面新增一个原生「分析看板」页面（`/analytics`），包含**业务分析**与**运维健康**两个 tab，数据分别来自 flowable-engine 的历史表聚合与 Micrometer 指标轮询，**不新增任何部署组件**（不引入 Prometheus/Grafana/ES 等）。

---

## 1. 项目背景（必读）

### 1.1 平台是什么

本项目基于 DeepSeek Harness（DSH，一个 Cordis agent harness，见仓库根 `CLAUDE.md`/`AGENTS.md`）构建企业级 profile。其中：

- **flowable-engine**（`apps/flowable-engine`）：基于 Spring Boot 3.3.5 + Flowable 7.0.1 的 BPMN 流程引擎，运行在 **:8090**，承担企业内"服务总线"角色——通过 BPMN 流程串接多个业务 SOR 系统，完成端到端业务流程。
- **web-console**（`apps/web-console`）：管理控制台。后端 Spring Boot（**:8080**），前端 React 19 + Vite + antd 5 + bpmn-js（`apps/web-console/frontend`）。提供 BPMN 流程设计器（含 `dsh:` 扩展属性面板）、流程部署与校验、实例/任务查看、组织管理、审计等。
- **expense-ctrl**（`apps/expense-ctrl`）：e2e DEMO 中的业务 SOR 示例（费用管控场景，expense-sor 模块运行在 **:8091**），用于端到端验收，非产品代码。
- **DSH enterprise profile（员工端，Electron）**：待办中心，以人机对话方式办理 user task。
- **backend profile（服务器端常驻 AI 实例）**：自动承接 DSH backend task（无人工参与，提交+轮询执行 AI 任务）。

流程中两类任务通过不同执行体完成：

| 任务类型 | 执行体 | 说明 |
|---|---|---|
| user task | 员工端 enterprise profile | 人工办理，产出 JSON 经 outputMappings 映射回流程变量 |
| DSH backend task（async ServiceTask，`DshBackendTaskDelegate`） | backend profile | 服务器端 AI 自动执行，本质是"服务器端自动运行的 user task"，支持超时升级（`DshTaskEscalationDelegate`）与多实例会签 |

### 1.2 数据库与认证模型（影响本设计的边界约定）

- **数据库**：本地 PostgreSQL（:5432，单实例两 schema）：
  - `flowable` schema：Flowable 引擎自动管理的 `ACT_*` 运行/历史表。**约定：web-console 不直查 ACT_\*，一切历史/运行查询经引擎 REST 端点**；引擎查自己的表不受此约束。
  - `public` schema：web-console 治理元数据（`platform_users`、应用/流程注册、审计等）及 expense-sor 业务表。
- **认证**：Supabase Auth 仅作为 JWT issuer（`SUPABASE_URL`），web-console 与 flowable-engine 各自通过 JWKS 本地验签（仅校验 iss+exp）。**流程身份 = JWT `sub`**。
- **平台角色**（`apps/web-console/backend/src/main/java/com/dsh/console/security/PlatformRole.java`，存于 `platform_users.platform_roles` 数组）：
  - `system_admin`：平台系统管理员，全部功能；
  - `app_admin`：应用管理员，业务配置操作；
  - `normal_user`：普通用户，主要走员工端。

### 1.3 术语表

| 术语 | 含义 |
|---|---|
| SOR | System of Record，业务记录系统（如 expense-ctrl 的 expense-sor） |
| backend task | DSH 扩展的 async ServiceTask，由服务器端 backend profile 自动执行 |
| 会签/多实例 | 一个审批节点由多人办理（Flowable multi-instance），单人/会签/串签由 `DshBpmnParseHandler` 部署时自动补齐 |
| 超时升级 | user task 超时后由 `DshTaskEscalationDelegate` 触发升级 |
| D0 形态 | 本设计的部署形态：不部署 Prometheus/Grafana，web-console 定时轮询引擎 `/actuator/metrics` 落库 |
| XES | IEEE 1849-2016 流程事件日志交换标准，本设计不实现，仅作为后续演进方向 |

### 1.4 为什么做这个（需求背景，一段话）

flowable-engine 作为服务总线串联端到端流程后，平台缺少对**流程运行数据**的分析能力（吞吐、耗时、瓶颈节点、办理人时效）和**引擎运行时健康**的可观测能力（async job 积压、backend task 成功率/时延、JVM/连接池）。业界调研（详见 §11 参考文档索引中的调研报告）结论：监控+BI 融合在一个原生页面、指标走 Micrometer→轮询落库，是当前规模下零新增组件的最优路径；XES 导出、流程挖掘、Prometheus/Grafana 均列为后续演进，本期不做。

---

## 2. 目标与范围

**业务分析 tab**（`system_admin` + `app_admin` 可见）：流程吞吐/完成率/耗时趋势（P95）、节点平均时长热力图（BPMN 画布渲染）、办理人时效榜。数据源 = 引擎新增 `/dsh/analytics/*` 聚合端点（SQL 直查 `ACT_HI_*`，HistoryLevel 已为 FULL）。

**运维健康 tab**（仅 `system_admin` 可见）：async/timer/dead-letter job 积压、backend task 成功率/时延、超时升级触发数、连接池/JVM 内存。数据源 = 引擎 Micrometer 指标，由 web-console 定时轮询 `/actuator/metrics`（JSON）落本地 PG 新表 `dsh_metrics_sample`。

**范围外（明确不做，V1）**：告警通知渠道（邮件/webhook，V1 仅审计事件+日志）、Prometheus/Grafana、XES 导出、流程变体/挖掘分析、按组织维度切片。

---

## 3. 环境与前置条件

### 3.1 运行环境

| 组件 | 版本/位置 | 说明 |
|---|---|---|
| JDK | 17 | 两个 Java 应用均为 Java 17 |
| Maven | 3.9.x | 构建两个 Spring Boot 应用 |
| Node.js | ^22.19 或 >=24 | 前端 Vite 8 + React 19 |
| PostgreSQL | 本地 :5432 | `flowable` + `public` 两 schema |
| Supabase 项目 | 仅 Auth | 提供 `SUPABASE_URL`（JWT issuer） |

### 3.2 构建与运行

```bash
# flowable-engine（:8090）
mvn -f apps/flowable-engine/pom.xml spring-boot:run
mvn -f apps/flowable-engine/pom.xml test          # 单测（H2 内存引擎，见 §3.4）

# web-console 后端（:8080）
mvn -f apps/web-console/backend/pom.xml spring-boot:run
mvn -f apps/web-console/backend/pom.xml test

# web-console 前端（Vite dev server）
cd apps/web-console/frontend && npm install && npm run dev   # 构建: npm run build，lint: npm run lint
```

### 3.3 环境变量（敏感值不写入仓库）

两个 Java 应用共用（见各自 `application.yml` 顶部注释）：
`SUPABASE_URL`、`SUPABASE_DB_HOST`、`SUPABASE_DB_USER`、`SUPABASE_DB_PASSWORD`。
web-console 另有：`FLOWABLE_BASE_URL`（引擎地址，默认应指向 `http://127.0.0.1:8090`）、`SKILLHUB_BASE_URL`、`SOR_BASE_URL`/`SOR_SERVICE_KEY`（expense-sor 对接，默认 `http://127.0.0.1:8091` / `demo-service-key`）。

### 3.4 测试模式与建表约定

- 引擎单测用 **H2 内存引擎**启动完整 Flowable 流程（参照 `apps/flowable-engine/src/test/java/com/dsh/flowable/api/DshHistoryQueryTest.java` 的既有模式：部署测试流程 → 跑实例 → 断言查询结果）。
- **无数据库 migration 框架**：所有建表/建索引 DDL 走手工执行，并同步补入手册 `docs/plans/2026-09-21-local-pg-setup-guide.md`（本设计 §8.1 的 DDL 也要补入该手册）。
- e2e 验收用的 DEMO 流程（含 backend task 与会签节点）通过 web-console 设计器在线部署，源码中无固定 BPMN 文件；验证时自行设计器绘制或复用已部署流程。

---

## 4. 已核实的关键代码事实（实施依据）

下表是设计时逐一核实过的代码事实，实施时如与代码冲突，以代码为准并在评审中提出。

| # | 事实 | 位置 |
|---|---|---|
| 1 | 引擎 pom 已含 `spring-boot-starter-actuator`（现仅 health 探活用）与 `spring-boot-starter-jdbc`（JdbcTemplate 已有查 public schema 先例） | `apps/flowable-engine/pom.xml` L44-48、L32-35 |
| 2 | 引擎 SecurityFilterChain 用 `AntPathRequestMatcher`（多 servlet 场景必须），`/actuator/health` permitAll，`/dsh/**` authenticated | `apps/flowable-engine/src/main/java/com/dsh/flowable/config/SecurityConfig.java` L74-84 |
| 3 | 引擎历史端点 `DshHistoryController` 只按实例查询，无定义级聚合端点 | `apps/flowable-engine/.../api/DshHistoryController.java` |
| 4 | web-console SecurityFilterChain：`/api/**` authenticated；backend-profiles register/skills 有 permitAll 先例（注释明确"内网服务间信任，第一期"） | `apps/web-console/backend/.../config/SecurityConfig.java` L78-83 |
| 5 | web-console 控制器角色门禁用方法级 `@PreAuthorize("hasAnyRole('SYSTEM_ADMIN','APP_ADMIN')")` / `hasRole('SYSTEM_ADMIN')` | `ApplicationController.java`、`AuditController.java` 等多处 |
| 6 | web-console 的 `flowableRestClient` 透传 interceptor 在后台线程（如定时任务）**不补** Authorization 头 | `RestClientConfig.java` L114-130 |
| 7 | web-console 后端目前**没有** `@EnableScheduling`/`@Scheduled` | 全局搜索无命中 |
| 8 | 前端无图表库（antd 本身无图表能力，需新增依赖）；HTTP 封装在 `src/api/client.ts`，现有 API 模块在 `src/api/*.ts` | `apps/web-console/frontend/package.json`、`frontend/src/api/` |
| 9 | 前端路由在 `App.tsx`，菜单角色显隐在 `ConsoleLayout.tsx` 的 `buildMenu()` | `frontend/src/App.tsx`、`frontend/src/layouts/ConsoleLayout.tsx` |
| 10 | bpmn-js 实例级路径高亮机制（NavigatedViewer + `canvas.addMarker` + CSS）已落地，可复用为定义级热力图 | `frontend/src/bpmn/BpmnHistoryViewer.tsx` L41-60 |
| 11 | 建表走手册手工 DDL | `docs/plans/2026-09-21-local-pg-setup-guide.md` |
| 12 | 角色常量全小写存库，`hasRole('SYSTEM_ADMIN')` 经 toUpperCase 拼接 `ROLE_` 前缀匹配 | `PlatformRole.java` javadoc |

---

## 5. 总体架构

```
【业务分析数据流】                              【运维健康数据流】
浏览器 → web-console /api/analytics/business/*    引擎 DshFlowableMetricsBinder（自定义 Gauge：
        │ @PreAuthorize 门禁                       async/timer/dead-letter/suspended job 数）
        ▼                                        + delegate 埋点（Timer/Counter → MeterRegistry）
web-console 后端（角色校验 + displayName join）              │
        │ flowableRestClient（透传用户 JWT，请求线程）           ▼
        ▼                                        引擎 GET /actuator/metrics（JSON，permitAll）
引擎 GET /dsh/analytics/*（新增，authenticated）    ▲ 仅暴露白名单指标
        │                                          │ 30s 轮询（调度线程，无用户上下文）
        ▼                                          ▼
引擎 JdbcTemplate SQL 聚合               web-console MetricsPoller（@Scheduled，新增）
（ACT_HI_* group by，聚合下推 PG）                  │ 批量 insert
                                                   ▼
【前端】/analytics 两个 tab  ←── 查询 ──  PG public.dsh_metrics_sample（新表）
```

### 关键设计决策（含理由，实施时不要偏离）

1. **业务聚合放引擎侧、SQL 直查 ACT_HI_\***。Flowable `HistoryService` 链式查询不支持 group-by/percentile 聚合，逐条拉内存聚合在数据量增长后不可行。引擎在 `flowable` schema 内用自己的 JdbcTemplate 做只读聚合 SQL——不违反"web-console 不碰 ACT_\*"约定（该约定约束 web-console；引擎查自己的表是本职，且 JdbcTemplate 已有先例，事实 #1）。
2. **运维指标轮询放 web-console（而非引擎写库）**。引擎保持无状态、不依赖 web-console 的库；轮询方持有数据，按 web-console 生命周期管理，轮询中断只影响图表新鲜度不伤引擎。
3. **引擎 `/actuator/metrics/**` permitAll（内网信任）**。原因：web-console 的透传 interceptor 在定时线程不补 JWT（事实 #6），现成先例是 web-console 的 backend-profiles register permitAll（事实 #4，注释明确"内网服务间信任，第一期"）。暴露面收敛：只暴露 `health,metrics` 两个端点（不含 env/configprops/beans），且指标只读白名单。**V2 收紧项：改为静态 service token**。
4. **不引入 `micrometer-registry-prometheus`**。D0 用 actuator 自带 JSON `/actuator/metrics` 端点即可（actuator 已含 micrometer-core）；将来升级 Prometheus/Grafana 时只需加该依赖换 `/actuator/prometheus` 抓取格式，埋点代码零改动（同为 MeterRegistry API），`dsh_metrics_sample` 表保留作冷存储。
5. **业务与运维同一页面、按角色分 tab**。两 tab 前端按角色显隐 + 后端 `@PreAuthorize` 双保险（对齐事实 #5 的既有模式）；指标表与治理数据同库，后续可做跨域关联分析（如 job 重试突增 vs 流程批量启动）。

---

## 6. 组 1：引擎分析聚合端点（flowable-engine）

新增两个类（包 `com.dsh.flowable.api`，与 `DshHistoryController` 同级）：

- `api/DshAnalyticsController.java`：REST 端点。
- `api/DshAnalyticsQueryService.java`：JdbcTemplate 聚合 SQL 封装。

所有端点 authenticated（复用现有 JWT 过滤链），方法上不做角色细分（与 `DshHistoryController` 同级；敏感度与历史查询一致，角色细分在 web-console 层做）。

统一查询参数：`days`（int，默认 30，**clamp 1-365**）；可选 `processDefinitionKey`（跨部署版本聚合：先按 key 从 `ACT_RE_PROCDEF` 换出全部版本的 `PROC_DEF_ID_`，语义对齐 `DshHistoryController` 的 key 过滤）。

### 6.1 端点契约

| 端点 | 返回 JSON | 用途 |
|---|---|---|
| `GET /dsh/analytics/overview` | `{started, completed, running, terminated, avgDurationMs, p95DurationMs}` | 概览卡片 |
| `GET /dsh/analytics/daily-volumes` | `[{date, started, completed}]` | 吞吐趋势折线 |
| `GET /dsh/analytics/activity-stats` | `[{activityId, activityName, activityType, count, avgDurationMs, maxDurationMs}]` | 节点热力图 + TOP 表 |
| `GET /dsh/analytics/task-stats` | `[{assignee, count, avgDurationMs, maxDurationMs}]`（count 倒序，限 50，user task 专属） | 办理人时效榜 |

### 6.2 SQL 语义（表在 `flowable` schema，引擎数据源已指向该 schema，SQL 不加前缀）

```sql
-- overview（p95 用 percentile_cont，聚合下推 PG）
SELECT count(*) FILTER (WHERE ...) AS started, ...
       percentile_cont(0.95) WITHIN GROUP (ORDER BY DURATION_IN_MILLISECOND_) AS p95
FROM ACT_HI_PROCINST WHERE START_TIME_ >= now() - (:days || ' days')::interval ...

-- activity-stats：按 PROC_DEF_ID_（key 换出的全部版本 id 集合）+ ACT_ID_ 分组
SELECT AI.ACT_ID_, MAX(AI.ACT_NAME_), MAX(AI.ACT_TYPE_), COUNT(*),
       AVG(AI.DURATION_IN_MILLISECOND_), MAX(AI.DURATION_IN_MILLISECOND_)
FROM ACT_HI_ACTINST AI
WHERE AI.PROC_DEF_ID_ IN (...) AND AI.START_TIME_ >= ... AND AI.DURATION_IN_MILLISECOND_ IS NOT NULL
GROUP BY AI.ACT_ID_
```

三个必须处理的语义边界（单测覆盖，见 §6.4）：

1. `ACT_HI_ACTINST.DURATION_IN_MILLISECOND_` 在节点**仍在进行时为 NULL**，聚合须剔除；
2. **多实例节点**（会签/串签）每个成员产生一行，count 天然按"份数"计——符合会签分析语义，不要去重；
3. sequenceFlow 行 `ACT_TYPE_='sequenceFlow'` 也参与统计（连线频次用于路径热力），前端按类型区分渲染。

### 6.3 索引核对（实施时验证）

Flowable 默认在 `ACT_HI_PROCINST(START_TIME_)`、`ACT_HI_ACTINST(PROC_INST_ID_)` 等有索引，但 `PROC_DEF_ID_ + START_TIME_` 组合查询未必走索引。V1 数据量小可接受全扫；在 local-pg-setup-guide 手册补一条**可选**索引 DDL（`CREATE INDEX ... ON flowable.ACT_HI_ACTINST (PROC_DEF_ID_, START_TIME_)`），数据量上来后手工执行。

### 6.4 单测

`DshAnalyticsQueryServiceTest`：参照 `DshHistoryQueryTest` 的 H2 内存引擎模式——部署测试流程 → 跑实例 → 调聚合 SQL → 断言数值，覆盖 §6.2 三个边界（NULL duration 剔除、多实例计数、key 跨版本聚合）。

---

## 7. 组 2：引擎指标暴露与埋点（flowable-engine）

### 7.1 暴露 metrics 端点

`application.yml`（注意：该文件目前没有 `management:` 段，新增）：

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,metrics   # 仅这两个；不暴露 env/beans/configprops
```

`SecurityConfig.securityFilterChain` 增加一行（`AntPathRequestMatcher` 写法与现有一致，事实 #2）：

```java
.requestMatchers(AntPathRequestMatcher.antMatcher("/actuator/metrics/**")).permitAll()
```

注释注明：内网信任先例（对齐 web-console backend-profiles register permitAll），V2 收紧为 service token。

### 7.2 自定义业务指标（Micrometer）

新增 `metrics/DshFlowableMetricsBinder.java`（`implements MeterBinder`，`@Component`）。注册 Gauge，取值函数包 `ManagementService` 查询（Micrometer 读取时惰性求值，无需自己轮询）：

| Gauge | 取值 |
|---|---|
| `dsh.flowable.jobs.async` | `managementService.createAsyncJobQuery().count()` |
| `dsh.flowable.jobs.timer` | `createTimerJobQuery().count()` |
| `dsh.flowable.jobs.deadletter` | `createDeadLetterJobQuery().count()` |
| `dsh.flowable.jobs.suspended` | `createSuspendedJobQuery().count()` |

埋点（改两处现有代码，各 +3 行左右）：

- `delegate/DshBackendTaskDelegate.java`：注入 `MeterRegistry`；`Timer.Builder("dsh.backend.task").tag("outcome", "success|failed")` 计时 + 失败时 `Counter dsh.backend.task.failure` 递增。成功率/时延从同指标 COUNT/TOTAL_TIME 的两次采样差分计算（见 §8.4）。
- `delegate/DshTaskEscalationDelegate.java`：`Counter dsh.task.escalation`（超时升级触发数）。

### 7.3 验证

- 单测：`DshFlowableMetricsBinderTest`（H2 引擎建 job 后断言 Gauge 值变化）；埋点在现有 `DshBackendTaskDelegateTest`/`DshTaskEscalationDelegateTest` 里用 `SimpleMeterRegistry` 补断言。
- 手工：`curl http://localhost:8090/actuator/metrics/dsh.backend.task`（**无 Authorization 头**）返回 JSON。

---

## 8. 组 3：web-console 指标采集与存储

### 8.1 建表（DDL 同步补入 local-pg-setup-guide 手册，手工执行）

```sql
CREATE TABLE public.dsh_metrics_sample (
    id BIGSERIAL PRIMARY KEY,
    metric TEXT NOT NULL,          -- 指标名，如 dsh.flowable.jobs.async
    statistic TEXT NOT NULL,       -- VALUE / COUNT / TOTAL_TIME / MAX
    value DOUBLE PRECISION NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dsh_metrics_sample_metric_ts ON public.dsh_metrics_sample (metric, ts DESC);
```

### 8.2 新增 `analytics/` 包（`com.dsh.console.analytics`）

```
MetricsPoller.java          @Component，轮询调度
MetricsJdbcRepository.java  批量 insert + 按指标/时间窗查询 + 过期清理 delete
AnalyticsOpsController.java       /api/analytics/ops/*
AnalyticsBusinessController.java  /api/analytics/business/*
dto/...
```

- `ConsoleApplication` 加 `@EnableScheduling`（当前没有，事实 #7）。
- **MetricsPoller**：`@Scheduled(fixedDelayString = "${dsh.analytics.poll-interval-ms:30000}")`。复用 `flowableRestClient` bean——其透传 interceptor 在调度线程不补头（事实 #6），正好走引擎 permitAll 的 metrics 端点。轮询白名单在 `application.yml` 配置：`dsh.analytics.metrics: [...]`，默认含 4 个 job Gauge、`dsh.backend.task`、`dsh.task.escalation`、`hikaricp.connections.active`、`jvm.memory.used`。逐个 `GET /actuator/metrics/{name}` 解析 `measurements[]`（每个 statistic 一行）批量 insert。单次失败仅 WARN 日志、下轮重试（V1 不做空洞补采）。
- **保留期清理**：`@Scheduled(cron = "0 30 3 * * *")` delete `ts < now() - interval ':retention-days days'`（`dsh.analytics.retention-days`，默认 90）。
- **简单阈值告警（V1）**：`dsh.analytics.alerts.<metric>: max 数值` 配置；轮询落库后越限写一条审计事件（复用 `audit/AuditService` 现有方法）+ WARN 日志；同一指标 **2 小时内不重复**（查最近告警审计事件去重）。无邮件/webhook。

### 8.3 运维查询端点（`/api/analytics/ops/*`，`@PreAuthorize("hasRole('SYSTEM_ADMIN')")`）

| 端点 | 返回 |
|---|---|
| `GET /api/analytics/ops/series?metric=&from=&to=&statistic=VALUE` | `[{ts, value}]` 折线数据 |
| `GET /api/analytics/ops/summary` | 白名单指标的最新值 + 1h 窗口聚合（backend task 成功率、平均时延、job 积压当前值） |

时延/成功率在 Service 层对 `dsh_metrics_sample` 的 COUNT/TOTAL_TIME 序列做窗口差分（`value_now - value_1h_ago`），**不在前端算**。

### 8.4 业务代理端点（`/api/analytics/business/*`，`@PreAuthorize("hasAnyRole('SYSTEM_ADMIN','APP_ADMIN')")`）

`overview | daily-volumes | activity-stats | task-stats` 四个端点：参数校验（days clamp 1-365）→ `FlowableRestClient`（`com.dsh.console.runtime`）新增四个对应方法（透传用户 JWT，请求线程上下文有效）→ 引擎 `/dsh/analytics/*`。

`task-stats` 返回的 `assignee` 是 Supabase user.id，web-console 侧 join `platform_users` 补 `displayName` 再返回（引擎不 join 用户表，保持引擎对治理数据只读薄用）。

### 8.5 验证

- Poller 单测：mock 引擎 metrics JSON → 断言批量 insert 与 statistic 拆行；白名单外指标不采集。
- 清理/告警单测：审计事件 2h 去重窗口。
- 手工：启动后 `select metric, count(*) from dsh_metrics_sample group by 1` 有行且持续增长；3 天前的测试行被清理。

---

## 9. 组 4：前端分析页

### 9.1 依赖与路由

- **新增图表依赖**（前端目前没有任何图表库，事实 #8）：推荐 `@ant-design/charts`（与 antd 5 视觉一致）；备选 `recharts`（更轻）。实施时二选一，在 PR 中说明选择理由。
- `App.tsx` 加 `<Route path="analytics" element={<AnalyticsPage />} />`。
- `ConsoleLayout.buildMenu()`：`system_admin || app_admin` 时在"流程定义"菜单项后插入 `{ key: '/analytics', icon: <BarChartOutlined />, label: '分析看板' }`。
- API 模块新建 `src/api/analytics.ts`，复用 `src/api/client.ts` 的 axios 封装。

### 9.2 `pages/Analytics.tsx`（两个 tab）

**业务分析 tab**（app_admin 可见）：

- 顶部过滤器：应用 → 流程定义（key）级联下拉（复用 `src/api/apps.ts`/`workflows.ts` 现有 API）+ 时间范围（7/30/90 天 Segmented）。
- 概览卡（antd Statistic）：发起/完成/运行中/终止数、平均端到端时长、P95 时长。
- 每日吞吐折线（started/completed 双线）。
- 办理人时效表（antd Table，displayName，可跳用户页）。
- 节点热力图（见 §9.3）。

**运维健康 tab**（仅 system_admin，前端按角色显隐 + 后端 `@PreAuthorize` 双保险）：

- 实时卡：async/timer/dead-letter job 数、backend task 成功率（1h 窗）、平均时延、升级触发数、连接池/JVM。
- 趋势折线：按指标多选 + 时间窗查询 `ops/series`。

### 9.3 `bpmn/BpmnAnalyticsViewer.tsx`（定义级热力图，业务 tab 内）

复用 `BpmnHistoryViewer.tsx` 已验证的模式（事实 #10：NavigatedViewer + `canvas.addMarker` + CSS marker 类）：

- 输入：部署版 BPMN XML——经 web-console 走引擎 `GET /dsh/history/bpmn-xml?processDefinitionId=`（与实例路径图同源）+ `activity-stats` 数据。
- 渲染：按 `avgDurationMs` 分三桶挂 marker（CSS 类 `dsh-ana-low/mid/high`，绿/黄/红）。**阈值默认按该流程内节点时长的 P33/P66 分位自动分桶**（避免手工阈值），可配置覆盖；sequenceFlow 按频次只做粗细（低频半透明）。
- 交互：节点 hover 显示 count/avg/max（bpmn-js `overlays.add` 挂轻量 HTML 角标）；侧栏同步 TOP 10 最慢节点列表，点击列表项 `canvas.zoom` 定位到节点。
- 图例：固定角落 legend（三色 + 说明）。

### 9.4 验证

手工 e2e：以含 backend task 与会签多实例的流程跑几单，确认热力图节点/连线统计与 `ACT_HI_*` 手查数值一致；普通用户登录菜单无"分析看板"；app_admin 看不到运维 tab（直接调 ops API 返回 403）。

---

## 10. 工作项清单（4 组串行，组间有集成环）

### 组 1：引擎分析端点

| # | 工作项 | 验证 |
|---|---|---|
| 1 | `DshAnalyticsController` + `DshAnalyticsQueryService`（4 端点 + days/key 参数 clamp） | H2 单测三边界（NULL duration 剔除、多实例、key 跨版本） |
| 2 | 索引核对 + 手册补可选索引 DDL | EXPLAIN 确认（数据量大时） |

### 组 2：引擎指标暴露

| # | 工作项 | 验证 |
|---|---|---|
| 3 | application.yml exposure + SecurityConfig permitAll 一行 | curl 无认证取 metrics JSON |
| 4 | `DshFlowableMetricsBinder`（4 Gauge） | 单测 + `/actuator/metrics/dsh.flowable.jobs.async` |
| 5 | delegate 埋点（backend task Timer/Counter + escalation Counter） | 现有 delegate 单测补断言 |

### 组 3：web-console 采集

| # | 工作项 | 验证 |
|---|---|---|
| 6 | 建表 DDL 补手册 + 执行 | 表/索引存在 |
| 7 | `@EnableScheduling` + `MetricsPoller` + `MetricsJdbcRepository` + 配置 | 查库行数随轮询增长 |
| 8 | 保留期清理 + 阈值告警（审计事件去重） | 单测 + 手工改阈值触发 |
| 9 | ops/business 两 Controller + `FlowableRestClient` 四个代理方法 + displayName join | curl 带各角色 JWT：权限矩阵（200/403） |

### 组 4：前端

| # | 工作项 | 验证 |
|---|---|---|
| 10 | 图表依赖 + 路由 + 菜单 | 三角色菜单可见性 |
| 11 | `Analytics.tsx` 两 tab + `api/analytics.ts` | 数据渲染与 API 一致 |
| 12 | `BpmnAnalyticsViewer` 热力图 | 与 ACT_HI 手查数值一致；定位/角标交互 |

**组间集成环**：组 1+2 完成后 curl 引擎直连验证；组 3 与组 2 联跑看库；组 4 全链路 + e2e DEMO 场景回归。

---

## 11. 边界、约束与升级路径

- **接受的约束**：轮询粒度 15-30s（非实时推送）；`dsh_metrics_sample` 单表无分区（90 天保留，约 15 个指标 × 每 30s 采样，日增约 2k 行，年量级 <1M 行，PG 无压力）；引擎 metrics permitAll 依赖内网边界（V2 收紧为 service token）。
- **升级路径（不在本期）**：Prometheus/Grafana（加 `micrometer-registry-prometheus`，埋点零改动，`dsh_metrics_sample` 留作冷存与业务关联分析）；XES 导出器（组 1 同一批 ACT_HI 查询换成事件序列输出的旁路扩展）；流程变体/挖掘分析；按组织维度切片（等 org routing 数据沉淀后加维度列）。

---

## 12. 端到端手工验证清单（交付验收）

环境：本地 PG + web-console(:8080) + flowable-engine(:8090) + 通过设计器部署的 DEMO 流程（含 backend task 与会签节点；可参考 e2e DEMO 场景 `apps/expense-ctrl`）。

| # | 步骤 | 预期 |
|---|---|---|
| 1 | 引擎启动后 `curl :8090/actuator/metrics/dsh.flowable.jobs.async`（无认证头） | 返回 JSON，含 VALUE measurement |
| 2 | 跑 3 单 DEMO 流程（含 backend task、会签） | 引擎日志出现埋点计数 |
| 3 | 等 1 分钟查 `dsh_metrics_sample` | 白名单指标行数增长；backend task COUNT/TOTAL_TIME 行出现 |
| 4 | system_admin 登录 → 分析看板业务 tab | 概览数与手工 SQL 一致；热力图会签节点计数=成员数 |
| 5 | 切运维 tab | job 数/成功率曲线正常渲染 |
| 6 | app_admin 登录 | 见业务 tab，不见运维 tab；直接 curl ops API 返回 403 |
| 7 | normal_user 登录 | 菜单无分析看板；直接 curl business API 返回 403 |
| 8 | 配置 `dsh.analytics.alerts.dsh.flowable.jobs.deadletter: max=0` 并人为造 dead-letter job | 审计页出现告警事件，2h 内不重复 |

---

## 附：参考文档索引（均在 `docs/plans/`）

| 文档 | 与本设计的关系 |
|---|---|
| `2026-09-25-process-analytics-bam-research.md` | 前置调研：业界规范（BAM/XES/IEEE 1849）、开源方案对比、方案选型依据。实施不依赖它，仅供追溯决策来源 |
| `2026-09-21-local-pg-setup-guide.md` | 本地 PG 建表手册：本设计 §6.3 可选索引与 §8.1 指标表 DDL 须补入此手册 |
| `2026-09-14-dsh-backend-task-design.md` | backend task 机制背景（理解 `DshBackendTaskDelegate` 与埋点对象） |
| `2026-08-19-supabase-setup-guide.md` | Supabase Auth（JWT issuer）配置背景 |
