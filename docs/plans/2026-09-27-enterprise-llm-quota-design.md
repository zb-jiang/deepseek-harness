# DSH 企业平台 · 企业统一 LLM 接入与额度控制设计文档

## 0. 一句话概述

在 `web-console` 中新增一套企业统一 LLM 管理能力：管理员配置企业采购的模型接入；按部门和个人发放“按模型、按月”的 token 额度；员工端只显示企业已开通且本人可用的模型；每次调用先经过自研额度控制层再转发到 New API；后台按人、部门、模型、日期查看消耗热力图。

***

## 1. 背景与目标

### 1.1 当前平台背景

本项目不是一个单独的聊天产品，而是一个企业 AI 平台。现有企业侧能力已经包含：

- web-console 管理面：组织/用户/角色治理、流程设计与发布、实例管理、审计；
- flowable-engine：Flowable 流程引擎（审批、待办）；
- DSH 员工端（Electron 应用）：AI 对话、待办办理，模型配置走用户自带凭据或直连供应商。

本次需求不是重写 DSH 的通用模型能力，而是在企业 profile 上增加一层“企业级模型治理与额度控制”。

### 1.2 建设目标

本设计覆盖以下内容：

- 企业统一模型接入管理（New API 渠道之上的逻辑模型目录）；
- 按用户/部门、按模型、按月发放 token 额度，支持生效区间与启停；
- 每个“用户 + 模型”的有序额度路由链与耗尽策略（硬拦截 / 软提醒）；
- 员工端统一推理入口：预留 → 转发 New API → 按实际 usage 结算；
- append-only 用量账本与按人/部门/模型/日的统计、近一年热力图。

***

## 2. 核心设计结论

### 2.1 为什么采用 “New API + 自研额度控制层”

本设计采用以下职责分工：

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| New API | 上游渠道接入、真实凭据保管、模型名映射、OpenAI 兼容转发 | 额度控制、企业模型目录 |
| web-console 额度控制层 | 企业模型目录、额度授权与路由、预留/结算、账本与统计 | 上游凭据保管、协议适配 |
| 员工端 DSH | 企业模型追加进现有模型列表、企业模型请求统一走代理端点 | 自配 provider 直连原供应商；企业模型经代理到 New API |

原因很简单：

New API 已解决“多上游接入、凭据管理、模型名统一”这类与业务无关的网关问题；而额度控制是企业治理语义（部门池、路由链、超额记账），开源网关没有对应概念，自研一层成本低于改造网关，且账本与统计完全自主可控。

**开源许可注意**：New API 采用 AGPLv3。企业内部自用不受影响；若本平台未来作为商业产品交付给客户部署，需评估 AGPL 的源码提供义务，或联系 New API 项目方获取商业许可。本设计对 New API 只做 API 调用，不修改、不二次分发其源码，属于独立进程间调用，耦合风险最低。

### 2.2 核心语义约束

以下规则是本设计的硬规则，第三方团队应按此语义实现：

- 员工端永远不直接访问 New API 与上游供应商，只调用 web-console 代理端点；
- New API 内部服务令牌不限额度，额度拦截只发生在自研额度控制层（§13.2）；
- 用量以 `llm_usage_ledger` 为唯一真相源，不从 New API 后台抄数（§15.1）；
- 网关模型名引用化：只能从 New API 模型清单下拉选择，创建后锁定不可改（§8.7）；
- 流式请求必须拿到最终 usage（`stream_options.include_usage=true`），否则无法结算（§10.4）；
- 所有额度语义按“用户 + 模型 + 自然月”三维独立计算。

***

## 3. 业务术语

| 术语          | 含义                                                                     |
| ----------- | ---------------------------------------------------------------------- |
| 企业模型        | 面向员工端暴露的企业统一模型，如 `GPT-5.4`、`Kimi-K2`。                                  |
| New API 渠道  | New API 中注册的上游渠道定义（Channel），包含上游凭据、Base URL、模型列表与模型映射，供 OpenAI 兼容接口调用。 |
| 内部服务令牌      | New API 中为本系统后端创建的专用调用令牌（Token），仅供 `web-console` 转发推理使用。               |
| 额度来源        | 本次请求扣减的来源。只允许 `user` 或 `org_unit` 两类。                                  |
| 额度路由链       | 某个“用户 + 模型”的有序额度池列表。系统按顺序依次尝试，直到找到可用来源。                                |
| 用户额度        | 针对单个用户、某个模型、某个月度的独立额度。                                                 |
| 部门额度        | 针对某个部门、某个模型、某个月度的共享额度。                                                 |
| 路由项         | 额度路由链中的一个顺位项，指向一个具体来源。                                                 |
| 硬拦截         | 当前来源不足时直接拒绝请求。                                                         |
| 软提醒         | 所有可用来源都不足时允许继续，超出的 token 计入兜底来源的 overage。                              |
| 用量主账本       | 本系统 append-only 的调用账本，是统计与审计真相源。                                       |

***

## 5. 产品语义

### 5.2 额度池顺序的定义

产品文案可以使用“优先使用个人额度”“优先使用部门额度”，但技术实现必须按“额度路由链”落地。

每个“用户 + 模型”配置一条有顺序的来源列表，例如：

| 顺位 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 个人池（user: 张三） | 优先扣个人额度 |
| 2 | 部门池（org_unit: 平台部） | 个人不足时扣部门共享额度 |

每次请求执行时，系统按顺位依次检查：

1. 该顺位项 `enabled`；
2. 该来源对当前模型存在生效授权（`findEffectiveGrant`：`enabled` 且 `effective_from <= 今天 <= effective_to`，`effective_to` 为 NULL 视为不限）；
3. 该来源当月可用量（`limit - consumed - reserved`）≥ 本次预留量。

第一个全部满足的顺位即中选，后续顺位不再检查。

如果所有顺位来源都不足，则按路由头上的 `exhaust_action` 处理：

- `block`（硬拦截）：写一条 `blocked` 账本行后拒绝请求（HTTP 409 `LLM_QUOTA_EXHAUSTED`）；
- `allow_overage`（软提醒）：兜底到最后一个启用顺位放行，超出部分按 §11.6 记超额。

### 5.3 多部门员工的处理规则

员工可能属于多个部门。对于同一模型，规则如下：

- 路由链按管理员显式配置落地：路由弹窗可为该用户同时挑选多个部门池（如先 A 部门池、后 B 部门池）；
- 部门池下拉不限制池归属部门，只按“所选企业模型下有生效授权”过滤（口径同 `findEffectiveGrant`，见 §9.3）；
- 调用时严格按路由顺位执行，不按员工部门归属自动展开部门池。

这条规则的目标是同时满足两点：

- 灵活：多部门员工的可用池不受“单一归属部门”限制，管理员可按业务显式编排顺位；
- 可控：只有显式配置进路由链的池才会被扣减，不会出现“因属于某部门就自动共享其额度”的隐式扣费。

### 5.4 额度耗尽处理规则

当额度路由链中的所有来源都不足时，系统执行以下策略之一：

- **硬拦截 `block`**：直接拒绝请求，账本先记一条 `blocked` 行供审计，错误码 `LLM_QUOTA_EXHAUSTED`（409）；
- **软提醒 `allow_overage`**：允许请求继续执行，兜底到最后一个启用顺位入账，超出正常额度的 token 记入 `overage_tokens`（详见 §11.6）。

策略配置在路由头 `exhaust_action` 字段上，按“用户 + 模型”生效；管理端路由表单以标签呈现（硬拦截=红、软提醒=橙）。

### 5.5 月度额度语义

月度额度按自然月统计，时区统一使用 `Asia/Shanghai`。

- 余额行按 `usage_month`（`yyyy-MM`）唯一键隔离，跨月首次命中时自动开新行，上月余额不结转；
- `monthly_limit_tokens` 是月度上限；月中新建的余额行按当次命中的授权额度取快照，已存在的余额行不随授权调整改写 limit；
- `monthly_limit_tokens` 为 -1 表示不限量：该池跳过余额检查直接中选，仍照常预留/消耗记账；无超额概念（`overage_tokens` 恒为 0）；与 0 语义不同（0 = 当月不可用，仍走余额检查并拒绝或软提醒）；
- 管理端授权列表的「当前周期剩余」列口径：授权（或余额行快照）为 -1 时返回 -1（界面显示「不限量」）；无余额行取授权当前值；有余额行按 `快照 limit - consumed - reserved`——除 -1 哨兵外的负数表示软提醒策略下已透支，不是不限量；
- 月份归属以账本 `usage_month` 为准（预留发生时即确定），不按 `completed_at` 归属。

***

## 6. 与现有代码的推荐落点

第三方团队应按以下位置实施，除非评审明确批准，不要擅自改到 DSH 核心通用包。

### 6.1 web-console 后端

新增包建议放在：

`apps/web-console/backend/src/main/java/com/dsh/console/llm/`

建议子包：

- `LlmAdminController` / `LlmEmployeeController` / `LlmProxyController` / `LlmAnalyticsController` — REST 端点；
- `LlmModelService` / `LlmQuotaService` / `LlmProxyService` / `LlmEmployeeService` / `LlmAnalyticsService` — 业务逻辑；
- `LlmCatalogJdbcRepository` / `LlmQuotaJdbcRepository` / `LlmLedgerJdbcRepository` — 持久化访问；
- `NewApiProperties` + `NewApiClient` — New API 连接配置与模型清单拉取；推理转发在 `LlmProxyService` 内完成；
- `LlmException` + `LlmExceptionHandler` — 统一错误码响应；
- `dto/` — `EmployeeModelDto`、`EnterpriseModelDto`、`QuotaGrantDto`、`UsageLedgerEntry`、`UserModelRouteDto`。

### 6.2 web-console 前端

建议新增页面：

- `LlmModels.tsx` — 企业模型管理（列表、新建/编辑、启停、删除）；
- `LlmQuotas.tsx` — 额度授权与用户路由（两个页签）；
- `LlmUsage.tsx` — 用量分析（近一年热力图、维度汇总、账本明细）。

### 6.3 员工端

应在企业 profile 内实现，不污染通用 profile。

推荐新增企业包：

`packages/enterprise/llm-access/`

职责：

- 登录后调用 `GET /api/llm/models` 拉取企业模型目录；
- 把企业模型**追加**到 DSH 现有模型选择 UI 的列表末尾（现有 provider 配置与模型选择功能不动；下拉只按显示名平铺，不展示路由池与余量）；
- 对话推理按当轮选中模型分流：选中的是企业模型 → 构造 `POST /api/llm/v1/chat/completions` 请求，经本地 DSH webserver（`127.0.0.1:3080`）代理转发；选中的是员工自配 provider → 沿用原有直连路径不变；
- 错误码映射为员工可读文案（`LLM_QUOTA_EXHAUSTED` → “本月额度已用完”等，仅作用于企业模型路径）。

现有模型选择 UI 保持复用，不另造一套模型选择组件。

***

## 7. 数据模型设计

以下为建议表结构。表名可按仓库惯例调整，但字段语义不得变。

### 7.1 `llm_enterprise_models`

用途：企业对外暴露的逻辑模型。

| 字段                       | 类型                    | 说明                              |
| ------------------------ | --------------------- | ------------------------------- |
| `id`                     | UUID PK               | 主键                              |
| `display_name`           | varchar(128)          | 前端显示名，如 `GPT-5.4`               |
| `gateway_model_name`     | varchar(128) unique   | 经网关路由的逻辑模型名，即员工端请求中的 `model` 值；需与 New API 渠道的 `models` 一致 |
| `model_params_json`      | jsonb                 | 温度、max\_tokens、额外 header 等      |
| `reservation_tokens`     | integer               | 请求预留 token，硬拦截预检使用              |
| `enabled`                | boolean               | 是否对企业启用                         |
| `created_at`             | timestamptz           | 创建时间                            |
| `updated_at`             | timestamptz           | 更新时间                            |

说明：

- `gateway_model_name` 创建后不可修改（额度与账本都按它归属，改名会使历史数据断裂），且创建时必须存在于 New API 模型清单（§8.7）；
- `reservation_tokens` 是每次请求的预检预留量（如 8000），用于在拿到真实 usage 前占住额度，防止并发透支；
- `model_params_json` 可配 `inputPricePer1M` / `outputPricePer1M`（USD/百万 token），用于账本成本估算；`temperature`、`max_tokens` 等推理参数由员工端请求体自带，此处不强制。

### 7.2 `llm_quota_grants`

用途：某来源对某模型的月度额度定义。

| 字段                     | 类型            | 说明                                   |
| ---------------------- | ------------- | ------------------------------------ |
| `id`                   | UUID PK       | 主键                                   |
| `subject_type`         | varchar(16)   | `user` 或 `org_unit`                  |
| `subject_id`           | UUID          | `platform_users.id` 或 `org_units.id` |
| `model_id`             | UUID FK       | 企业模型                                 |
| `monthly_limit_tokens` | bigint        | 月度 token 上限；-1=不限量，0=当月不可用           |
| `enabled`              | boolean       | 是否启用                                 |
| `effective_from`       | date          | 生效日期                                 |
| `effective_to`         | date nullable | 失效日期                                 |
| `created_at`           | timestamptz   | 创建时间                                 |
| `updated_at`           | timestamptz   | 更新时间                                 |

约束：

- 生效口径为 `enabled` 且 `effective_from <= 今天 <= effective_to`（`effective_to` 为 NULL 视为长期有效）；同主体同模型存在多条启用授权时，以 `created_at` 最新一条为生效（`findEffectiveGrant`）；
- 授权只定义“月度上限”，不直接产生余额；余额行在该来源首次被路由命中时按授权快照创建（§11.3）；
- `monthly_limit_tokens` 允许 0（表示该池当月不可用，但不阻止软提醒路径的记账归属）与 -1（表示不限量，运行时跳过余额检查、无超额概念）；小于 -1 的值在创建/编辑时被拒绝。

### 7.3 `llm_user_model_routes`

用途：定义某个用户对某个模型的额度路由头与耗尽策略。

| 字段               | 类型          | 说明                        |
| ---------------- | ----------- | ------------------------- |
| `id`             | UUID PK     | 主键                        |
| `user_id`        | UUID FK     | `platform_users.id`       |
| `model_id`       | UUID FK     | 企业模型                      |
| `exhaust_action` | varchar(24) | `block` / `allow_overage` |
| `enabled`        | boolean     | 是否启用                      |
| `created_at`     | timestamptz | 创建时间                      |
| `updated_at`     | timestamptz | 更新时间                      |

约束：

- `(user_id, model_id)` 唯一：一个用户对一个模型只有一条路由头；
- `exhaust_action` 只允许 `block` / `allow_overage`；
- 保存校验：模型必须存在、路由主体（用户）必须存在；不校验池授权——运行时对无生效授权的顺位直接跳过，管理端下拉只列有生效授权的池（§9.3）。

### 7.4 `llm_user_model_route_items`

用途：定义额度路由链的顺位项。

| 字段            | 类型          | 说明                                   |
| ------------- | ----------- | ------------------------------------ |
| `id`          | UUID PK     | 主键                                   |
| `route_id`    | UUID FK     | 引用 `llm_user_model_routes.id`        |
| `priority`    | integer     | 顺位，数字越小优先级越高，从 1 开始连续递增              |
| `source_type` | varchar(16) | `user` / `org_unit`                  |
| `source_id`   | UUID        | `platform_users.id` 或 `org_units.id` |
| `enabled`     | boolean     | 是否启用                                 |
| `created_at`  | timestamptz | 创建时间                                 |
| `updated_at`  | timestamptz | 更新时间                                 |

约束：

- `(route_id, priority)` 唯一，顺位从 1 开始；保存路由时顺位项整体替换（先删后插），顺位未改动时跳过替换；
- 账本 `route_item_id` 外键 `ON DELETE SET NULL`：顺位项是被整体替换的配置行，账本行只保留命中时点的审计快照，引用项被删除时置空而不阻止配置更新；
- 保存校验只验证来源主体存在性，不校验池授权；运行时对无生效授权的顺位 `continue` 跳过；
- 前端表单保证顺位项连续且不重复选同一池（§9.3）。

### 7.5 `llm_usage_ledger`

用途：append-only 主账本。统计、审计、热力图都以它为真相源。

| 字段                   | 类型                    | 说明                                                            |
| -------------------- | --------------------- | ------------------------------------------------------------- |
| `id`                 | UUID PK               | 主键                                                            |
| `request_id`         | varchar(128) unique   | 本系统生成的请求 ID                                                   |
| `usage_month`        | char(7)               | `yyyy-MM`                                                     |
| `user_id`            | UUID FK               | 发起调用的用户                                                       |
| `route_id`           | UUID FK nullable      | 命中的额度路由头                                                      |
| `route_item_id`      | UUID FK nullable      | 命中的额度路由项                                                      |
| `selected_priority`  | integer nullable      | 命中的顺位                                                         |
| `org_unit_id`        | UUID nullable         | 调用时激活的部门来源；个人来源时为空                                            |
| `source_type`        | varchar(16)           | `user` / `org_unit`                                           |
| `source_id`          | UUID                  | 额度来源 ID                                                       |
| `model_id`           | UUID FK               | 企业模型                                                          |
| `session_id`         | varchar(128) nullable | DSH session ID                                                |
| `gateway_request_id` | varchar(128) nullable | New API 返回的请求 ID（响应头 `X-Oneapi-Request-Id`，用于辅助对账）            |
| `status`             | varchar(24)           | `reserved` / `completed` / `blocked` / `failed` / `cancelled` |
| `reserved_tokens`    | bigint                | 预留 token                                                      |
| `prompt_tokens`      | bigint                | 实际 prompt token                                               |
| `completion_tokens`  | bigint                | 实际 completion token                                           |
| `total_tokens`       | bigint                | 实际总 token                                                     |
| `overage_tokens`     | bigint                | 超额 token                                                      |
| `estimated_cost`     | numeric(18,6)         | 估算成本                                                          |
| `error_code`         | varchar(64) nullable  | 失败码                                                           |
| `error_message`      | text nullable         | 失败原因摘要                                                        |
| `created_at`         | timestamptz           | 创建时间                                                          |
| `completed_at`       | timestamptz nullable  | 完成时间                                                          |

### 7.6 `llm_monthly_balances`

用途：按来源、按模型、按月维护快速余额视图，避免每次从 ledger 全量求和。

| 字段                | 类型          | 说明                  |
| ----------------- | ----------- | ------------------- |
| `id`              | UUID PK     | 主键                  |
| `usage_month`     | char(7)     | `yyyy-MM`           |
| `source_type`     | varchar(16) | `user` / `org_unit` |
| `source_id`       | UUID        | 来源 ID               |
| `model_id`        | UUID FK     | 企业模型                |
| `limit_tokens`    | bigint      | 本月上限快照              |
| `reserved_tokens` | bigint      | 当前预留中 token         |
| `consumed_tokens` | bigint      | 已完成实扣 token         |
| `overage_tokens`  | bigint      | 已超额 token           |
| `updated_at`      | timestamptz | 更新时间                |

唯一键：

`(usage_month, source_type, source_id, model_id)`

### 7.7 索引与并发要求

第三方团队必须补齐以下索引：

```sql
CREATE UNIQUE INDEX uk_llm_models_gateway ON llm_enterprise_models (gateway_model_name);
CREATE INDEX idx_llm_grants_lookup ON llm_quota_grants (subject_type, subject_id, model_id, enabled);
CREATE UNIQUE INDEX uk_llm_routes_user_model ON llm_user_model_routes (user_id, model_id);
CREATE INDEX idx_llm_route_items_route ON llm_user_model_route_items (route_id, priority);
CREATE UNIQUE INDEX uk_llm_ledger_request ON llm_usage_ledger (request_id);
CREATE INDEX idx_llm_ledger_month_source ON llm_usage_ledger (usage_month, source_type, source_id, model_id);
CREATE INDEX idx_llm_ledger_user_month ON llm_usage_ledger (user_id, usage_month);
CREATE INDEX idx_llm_ledger_created ON llm_usage_ledger (created_at);
CREATE UNIQUE INDEX uk_llm_balances ON llm_monthly_balances (usage_month, source_type, source_id, model_id);
```

并发要求：

- 余额行读写一律先 `SELECT ... FOR UPDATE`（`lockOrCreateBalance`），行不存在则按当月授权快照惰性创建；
- 预留（`addReserved`）、结算（`settle`）、释放（`releaseReserved`）都在持有余额行锁的事务内执行；
- 账本行按 `request_id` 唯一，状态变更前先锁定该行（`findByRequestIdForUpdate`）；`settle` / `release` 只处理 `status='reserved'` 的行，保证两者幂等；
- 结算经同类内部调用不走 `@Transactional` 代理，统一用 `TransactionTemplate` 保证事务边界。

***

## 8. New API 安装与基础配置

本节是第三方团队必须执行的部署步骤。若运行环境不同，可调整部署方式，但产物行为必须一致。

### 8.1 部署目标

New API 在本项目中承担“企业统一 LLM Gateway”角色，必须满足：

- 提供 OpenAI 兼容的 `POST /v1/chat/completions`（含流式 SSE）与 `GET /v1/models`；
- 支持“一个企业模型 = 一个渠道”的映射（§8.6），`models` 与 `model_mapping` 可配置；
- 可为 web-console 创建额度不限、永不过期、不限模型的内部服务令牌（§8.5）；
- 与 web-console 独立部署、独立数据库，互不影响可用性。

### 8.2 部署方式

New API 是 Go 单二进制服务，本项目采用 **Release 二进制直接运行**，不使用 Docker、不依赖 Python 环境。

数据库约定如下：

- 独立库 `newapi`（专用账号 `newapi_user`），与 Supabase、web-console 数据库物理隔离；
- New API 自建自管其表结构，本系统不读写 New API 的库。

这种部署方式的目标是：

- 升级只需替换二进制并重启，无容器编排依赖；
- New API 与 web-console 进程隔离，任一侧故障不互相传染。

建库与建账号的 SQL 见《本地 PostgreSQL 配置手册》的 New API 专用数据库一节。

### 8.3 必需环境变量

以下环境变量是必须项：

```env
SQL_DSN=postgresql://newapi_user:<password>@<host>:5432/newapi
SESSION_SECRET=<long-random-string>
```

说明：

- `SQL_DSN`：New API 专用库连接串，账号只授权 `newapi` 一个库；
- `SESSION_SECRET`：New API 后台会话签名密钥，须为随机长串，按 §14.2 密钥管理保存，泄露会导致后台会话可伪造。

### 8.4 部署步骤

部署前提：

- PostgreSQL 已按《本地 PostgreSQL 配置手册》建好 `newapi` 库与 `newapi_user` 账号；
- Release 二进制已下载到 `apps\new-api\`；
- `3000` 端口未被占用。

```text
d:\works\deepseek-harness\apps\new-api\
  new-api-v1.0.0-rc.40.exe
  logs\
```

```powershell
$env:SQL_DSN="postgresql://newapi_user:<password>@localhost:5432/newapi"
$env:SESSION_SECRET="<long-random-string>"
```

```powershell
d:\works\deepseek-harness\apps\new-api\new-api-v1.0.0-rc.40.exe --port 3000
```

说明：

- New API 默认端口为 `3000`，可用 `--port` 覆盖。
- 首次启动后打开 `http://<host>:3000`，会自动进入**初始化向导**，依次完成四步：数据库检查（验证 `SQL_DSN` 连通）→ 管理员账户（新版无默认 `root/123456`，管理员登录凭据就在此步自行设置）→ 使用模式（企业内部网关场景保持默认）→ 审核并初始化。
- 初始化完成后，用刚创建的管理员账户登录后台。

### 8.5 内部服务令牌

`web-console` 与 New API 之间只有一个凭据——推理转发用的内部服务令牌：

```env
NEWAPI_BASE_URL=http://<host>:3000
NEWAPI_SERVICE_TOKEN=sk-<internal-service-token>
```

- `NEWAPI_SERVICE_TOKEN`：推理转发凭据。在后台新建专用用户 `svc-web-console`，为其创建**额度不限、永不过期、不限模型**的令牌。业务额度由自研额度控制层执行，New API 侧不做二次拦截。
- 该令牌同时用于拉取模型清单：web-console 后端以它调用 New API 的 OpenAI 兼容端点 `GET /v1/models`，返回的即"转发令牌可路由的模型名集合"（New API 按令牌分组从渠道 abilities 生成），作为 web-console 网关模型名的唯一合法取值源——模型清单只定义在 New API，本地只引用，且下拉取值与转发可达范围天然一致。
- 渠道配置不经任何 API 凭据：web-console 不调用 New API 管理 API（曾实现的渠道同步已移除，管理 API 的认证凭据随之废弃）。

### 8.6 渠道管理方式

New API 的模型接入单元是**渠道（Channel）**。本系统采用“**一个企业模型 = 一个 New API 渠道**”的映射方式，渠道由管理员在 New API 控制台（`http://<host>:3000`）**手工创建与维护**，web-console 不做任何渠道读写。

渠道与本系统企业模型字段的映射关系：

| 本系统字段                | New API 渠道字段    | 说明                                                        |
| -------------------- | --------------- | --------------------------------------------------------- |
| `gateway_model_name` | `name`          | 渠道名，直接使用网关模型名，稳定可读                                        |
| —                    | `type`          | 渠道类型编号，按 New API 文档的类型表选择（如 OpenAI 为 `1`）                 |
| —                    | `key`           | 上游真实 API Key，直接在渠道中配置                                     |
| —                    | `base_url`      | 上游 Base URL，直接在渠道中配置                                      |
| `gateway_model_name` | `models`        | 渠道声明支持的模型名，填网关模型名                                         |
| —                    | `model_mapping` | JSON，把网关模型名重定向到上游真实模型名，如 `{"gpt54-enterprise":"gpt-5.4"}`；上游映射只在渠道侧维护，本系统不存副本 |
| 固定值                  | `group`         | 统一使用 `default` 分组                                         |

调用效果：员工端请求 `model=gpt54-enterprise` → New API 按 `models` 匹配到该渠道 → 按 `model_mapping` 改写为上游真实模型名 → 携带上游凭据转发。

### 8.7 web-console 与渠道的对应约定

管理员在 `web-console` 保存企业模型后，需到 New API 控制台按 8.6 节映射关系创建同名渠道。约定：

- **网关模型名引用化**：web-console 模型接入页的网关模型名不再手工填写，而是从 New API 模型清单（`GET /v1/models`，转发令牌可路由集合）下拉选择——可搜索、底部展示模型总数与刷新入口、加载失败内联重试。后端在创建模型时校验该名存在于清单中，不存在报 `LLM_GATEWAY_MODEL_NOT_IN_NEWAPI`，New API 不可达报 `LLM_NEWAPI_UNAVAILABLE` 阻塞保存（不产生转发必然失败的空壳引用）。
- **网关模型名创建后锁定**：额度判定与用量账本都按它归属，改名会使历史数据断裂；编辑页该字段不可改，后端拒绝变更（`LLM_GATEWAY_MODEL_LOCKED`）。
- **企业模型删除**：模型接入页提供删除操作（二次确认）。已有任何用量账本记录的模型拒绝物理删除（`LLM_MODEL_IN_USE`，账本 append-only 且统计内 JOIN 模型表，删除会破坏历史统计），提示改用停用；无用量记录的模型在事务内级联清理其额度授权、用户路由（含顺位项）与月度余额行后删除，并记审计 `LLM_MODEL_DELETE`。
- 渠道的 `models` 必须包含企业模型的 `gateway_model_name`，否则该模型的推理请求会因渠道不匹配而失败。
- 渠道创建先于模型启用：先在 New API 建好渠道，再在 web-console 启用模型，避免员工选到不可用模型。
- web-console 模型页文案已提示上述约定；清单接口依赖转发令牌，故下拉取值始终是当前可转发集合，无需同步状态展示。

***

## 9. 管理员后台设计

### 9.1 菜单结构

建议在 `web-console` 新增一级菜单 `LLM 管理`，包含三个页面：

- **模型接入**（`LlmModels.tsx`）——企业模型 CRUD、启停、删除；
- **额度配置**（`LlmQuotas.tsx`）——额度授权与用户路由两个页签；
- **用量分析**（`LlmUsage.tsx`）——近一年热力图、维度汇总、账本明细。

三个页面仅 `SYSTEM_ADMIN` 角色可见，后端以 `@PreAuthorize("hasRole('SYSTEM_ADMIN')")` 双重校验。

### 9.2 企业模型页面

功能（与当前界面一致）：

- 模型列表列：显示名、网关模型名、额度预留、启停状态；
- 新建/编辑弹窗字段：显示名、网关模型名（从 New API 模型清单下拉，可搜索，底部展示模型总数与刷新入口，加载失败内联重试）、额度预留(token)、启用开关；
- 启用/停用开关；
- 删除（二次确认；有用量记录时阻塞，见 §8.7）。

企业模型页面展示的字段与说明：

| 字段 | 说明 | 界面状态 |
| --- | --- | --- |
| 显示名 `display_name` | 员工端模型选择器展示名 | 列表 + 弹窗，已实现 |
| 网关模型名 `gateway_model_name` | 创建后锁定；即员工请求的 `model` 值 | 列表 + 弹窗（清单下拉），已实现 |
| 预留 token `reservation_tokens` | 预检预留量 | 列表 + 弹窗，已实现 |
| 输入/输出单价（`model_params_json`） | USD 每百万 token，用于成本估算 | **界面未暴露**：后端存储与 `estimateCost` 读取已实现，未配置时成本估算为 0；单价目前需直接写入库中 `model_params_json`，或后续补编辑界面 |
| 启用状态 `enabled` | 停用后员工目录不可见、代理拒绝（`LLM_MODEL_NOT_FOUND`） | 列表 + 弹窗，已实现 |

### 9.3 额度配置页面

功能分成三块：

- **额度授权**：按主体（用户/部门）× 模型发放月度 token 上限，含生效区间（`effective_from` / `effective_to`）与启停；列表支持按模型过滤；
- **用户路由**：按“用户 × 模型”配置有序额度池顺位与耗尽策略（硬拦截/软提醒，标签红/橙）；保存时顺位项整体替换；
- **弹窗联动**：路由弹窗的池下拉按所选模型过滤，切换模型清空已选来源（口径见下段）。

用户路由弹窗的额度池下拉只列出所选企业模型下有生效授权的池（个人池=用户授权，部门池=部门授权，不限制池归属者/部门），口径与 `findEffectiveGrant` 一致：`enabled` 且生效区间覆盖当天；切换模型时清空已选来源，模型未选或该模型暂无授权池时下拉给出对应提示。

### 9.4 用量分析页面

页面至少提供以下维度：

- 按发起人（`user`，谁在用）；
- 按实际扣费个人池（`pool_user`）；
- 按实际扣费部门池（`pool_org_unit`）；
- 按模型（`model`）。

员工与部门为多对多关系（一个员工可属多个部门），不提供「部门员工合计用量」口径。维度切换在汇总卡标题与口径说明行呈现当前维度的统计口径。

月份选择器（`YYYY-MM`）作用于维度汇总与账本明细；热力图固定近一年、不受维度筛选影响。

页面至少提供以下图表：

- GitHub 风格近一年按天热力图（格式见 §12.3）；
- 维度汇总表（tokens、请求数、超额 tokens、估算成本）；
- 账本明细分页表（按月/用户/模型/状态过滤）。

***

## 10. 员工端设计

### 10.1 员工端展示目标

员工端**原有的 LLM provider 配置与模型选择机制全部保留，不做任何改动**：员工依然可以配置自己的 provider（自费的个人模型）并在对话中选用。

企业模型不是替换，而是**作为额外选项追加在现有模型列表末尾**：管理员开通了哪些企业模型、员工自己有哪些可用路由，企业模型就出现在模型选择器列表的后部。员工在某些任务上愿意使用自己花钱的模型属于正常选择，系统不做限制。

对企业模型而言，员工端不新增单独额度来源切换 UI，具体走哪个额度池由后台额度路由决定，员工无感。

### 10.2 模型目录 API

员工端启动后调用：

`GET /api/llm/models`

认证方式：员工当前 JWT（`isAuthenticated()`）。

返回示例：

```json
{
  "code": 0,
  "data": [
    {
      "id": "0d9f…",
      "gatewayModelName": "gpt54-enterprise",
      "displayName": "GPT-5.4",
      "exhaustAction": "block",
      "pools": [
        {
          "priority": 1,
          "sourceType": "user",
          "sourceId": "…",
          "sourceName": "张三",
          "monthlyLimitTokens": 1000000,
          "consumedTokens": 120000,
          "reservedTokens": 0,
          "remainingTokens": 880000
        }
      ]
    }
  ]
}
```

说明：

- 只返回企业模型（员工自配 provider 不经此 API，仍由 DSH 原有机制管理）；
- 员工端模型下拉列表**只按 `displayName` 平铺列出**，不展示路由池结构、不展示各池余量——路由池是后台记账概念，不是员工可见信息；
- 返回中的 `pools` 是服务端目录信息（各池当月概况），员工端 UI 当前不消费；若确认不需要余量提示类功能，可从 DTO 裁剪；
- 员工端不感知上游 provider、渠道与 New API 地址。

### 10.3 员工端调用 API

**适用范围：仅当本轮对话选中的是企业模型时才走本端点。** 员工在模型选择器里选了自己配置的 provider 时，推理请求沿用 DSH 原有直连路径，与本端点无关——每次请求的出口由当轮实际选中的模型决定。

员工端不直接访问 New API。选中的是企业模型时，员工端统一调用：

`POST /api/llm/v1/chat/completions`

认证方式：员工当前 JWT（`isAuthenticated()`）。

请求体保持 OpenAI 兼容格式，额外允许以下字段：

- 请求头 `X-DSH-Session-Id`（可选）：DSH session ID，写入账本便于按会话追溯；
- `model`：必须是员工可选企业模型（§10.2 目录）中的网关模型名；
- `stream`：响应模式开关——
  - `true`：**流式**。服务端以 SSE（Server-Sent Events）逐块返回增量内容，员工看到打字机效果，边生成边显示；DSH 对话 UI 默认走这种模式；
  - `false`：**非流式**。服务端完整生成后一次性返回整个 JSON 响应，员工等到全部结果才看到内容；适用于无 UI 的后台调用或不需要逐字展示的场景；
  - 两种模式的额度记账完全一致：流式在流末尾按 usage chunk 结算（§10.4），非流式在响应体的 `usage` 字段结算。

服务端收到后做以下事：

1. 校验 JWT 与模型（失败码 `LLM_MODEL_NOT_FOUND` / `LLM_ROUTE_NOT_CONFIGURED`）；
2. 执行额度预留（§11.3）；路由链全部不足时按 `exhaust_action` 硬拦截（409）或软提醒放行（§11.6）；
3. 以内部服务令牌转发 New API `POST /v1/chat/completions`，`model` 改写为网关模型名，其余字段透传；
4. 非流式：整体返回后按响应 `usage` 结算；流式：强制 `stream_options.include_usage=true`，SSE 逐行透传，末尾 usage 结算（§10.4）；
5. New API 调用失败或客户端断连时，幂等释放预留（`failed` / `cancelled`，§11.5）。

### 10.4 流式 usage 要求

**背景：为什么流式需要特殊处理 usage。** 流式模式下，OpenAI 兼容协议的每个 SSE chunk 只携带一小段增量文本（如几个字），**默认不含 token 统计**——不知道这次调用花了多少 prompt/completion tokens。而额度系统必须在每次调用后按真实用量记账。OpenAI 协议为此提供了一个开关：请求里带上 `stream_options: {"include_usage": true}`，上游就会在流**末尾**额外发一个收尾 chunk，里面有本次调用的完整 `usage`（prompt_tokens / completion_tokens / total_tokens）。额度系统就是靠读这个收尾 chunk 来结算的。

系统必须支持流式对话，因此服务端转发到 New API 时必须要求返回最终 usage。

实现要求（逐条解释）：

- 转发时强制注入 `stream_options.include_usage=true`（客户端未传也注入）：员工端 / DSH 原生请求通常不带这个字段，服务端转发前必须替它加上，否则流里永远收不到 usage，账就没法结——这是服务端的责任，不依赖客户端配合；
- 流式结算发生在流的最后一行处理完后：收到带 usage 的收尾 chunk 才执行结算事务（§11.4）；员工中途关掉页面 / 断网导致流中断时收不到 usage，此时不做扣费，改为按 `cancelled` 释放预留（员工没拿到完整结果不扣费，预留量退回）；
- 员工端保持 SSE 事件原样透传，不改写事件格式：服务端在中间只做监听记账，不增、不删、不改任何 SSE 事件，员工端拿到的流与直连上游完全一致，前端解析逻辑无需感知代理存在；
- 若某些 Provider 在流式路径上 usage 不稳定，必须列出该 Provider 的兼容性差异，不能静默忽略：个别上游模型/渠道可能不发收尾 usage chunk，出现这种情况要显式登记差异并处理（如按预留量结算或标失败），不允许无声吞掉导致账实不符。

### 10.5 与现有 DSH 模型选择机制的集成方式

第三方团队必须复用现有 DSH 模型选择机制，**以追加方式集成，不替换、不改动现有模型配置与选择功能**。

集成要求如下：

- **模型列表是合并而非替换**：模型选择器数据源 = DSH 现有模型列表（员工自配 provider 的模型）+ 企业模型目录（`GET /api/llm/models`）追加在后；员工端下拉只按显示名平铺，不展示路由池与余量（§10.2）；
- **按当轮选中模型分流请求出口**：本轮对话选中的是企业模型 → 推理请求构造为 `POST /api/llm/v1/chat/completions`；选中的是员工自配 provider → 沿用 DSH 原有直连路径，完全不变；
- **web 与 desktop 两种运行形态走同一条代理链路**：
  - web 模式：浏览器页面 → 本地 DSH webserver（`127.0.0.1:3080`，enterprise profile）→ 服务器 web-console `/api/llm/*` → New API；
  - desktop（Electron）模式：页面宿主从浏览器换成 Electron 窗口，DSH 后台服务同样以 enterprise profile 跑在本机 `127.0.0.1:3080`，代理链路与 web 模式**完全相同**——企业模型推理请求仍是页面 → 本地 webserver → 服务器 web-console → New API，员工自配 provider 仍走原有直连路径；
  - 两种形态下员工端代码不区分宿主，统一以本地 webserver 为企业模型请求的 baseURL，不直连服务器；
- 错误码映射为员工可读文案（仅作用于企业模型路径）：`LLM_QUOTA_EXHAUSTED` → “本月额度已用完”、`LLM_ROUTE_NOT_CONFIGURED` → “未分配模型权限”，其余透传 message；
- 不暴露 New API 地址、内部服务令牌与上游渠道信息。

这一条是实现边界约束。第三方团队可以调整适配代码落点，但交付结果必须满足“复用现有模型选择 UI、企业模型追加展示、按选中模型分流请求、隐藏真实上游 Provider”。

***

## 11. 额度控制算法

### 11.1 额度判定输入

每次请求进入控制层，至少需要以下输入：

- 员工身份：JWT `sub` → `user_id`；
- 网关模型名：请求 `model`，先解析为企业模型（不存在或停用 → `LLM_MODEL_NOT_FOUND` 404）；
- DSH session ID（可选，入账本便于追溯）；
- 预留量：模型 `reservation_tokens`。

### 11.2 来源解析算法

来源解析必须按以下规则：

1. 读该用户该模型的路由头；无路由 → `LLM_ROUTE_NOT_CONFIGURED` 403；
2. 按顺位遍历启用项：授权生效 → 锁定/创建余额行 → 可用量 ≥ 预留量即中选；
3. 全部不中：`block` 先写 `blocked` 账本行再拒绝（409）；`allow_overage` 兜底最后一个启用顺位；无任何启用顺位 → `LLM_ROUTE_NOT_CONFIGURED`；
4. 中选后写入 `reserved` 账本行，记录来源、顺位与路由项。

重要：一旦选中来源，本次请求的来源、顺位与路由项即被锁定，不再变更。

### 11.3 预留算法

由于流式请求开始时拿不到最终 token，系统采用“路由选择 + 预留后结算”的方式。

步骤：

1. `lockOrCreateBalance(月, 来源, 模型, 当月授权 limit)` 锁定余额行；行不存在则按授权快照创建（软提醒兜底时无授权 limit 视为 0）；
2. 计算可用量 `available = limit - consumed - reserved`；普通路径要求 `available >= reservation_tokens` 才可中选；
3. 中选即 `reserved += reservation_tokens`，账本写 `reserved` 行；
4. 软提醒路径跳过可用量检查，对兜底顺位照常预留（§11.6）。

`projected = reserved_tokens + consumed_tokens + reservation_tokens`

### 11.4 完成结算算法

New API 返回最终 usage 后，进入第二个事务：

1. 按 `request_id` 锁账本行；非 `reserved` 状态直接返回（幂等）；
2. 锁定余额行，计算正常可用量 `availableBefore = max(0, limit - consumed)`；
3. 计算超额 `overage = max(0, total - availableBefore)`；
4. `reserved_tokens -= ledger.reserved_tokens`；
5. `consumed_tokens += total_tokens`，`overage_tokens += overage`；
6. 账本行置 `completed`，记录 prompt/completion tokens、超额、估算成本与网关请求 ID。

usage 缺失时按 0 实扣并释放预留，避免预留泄漏。

### 11.5 失败与取消

若请求在 New API 调用前失败：

- 模型/路由校验不通过：无预留，直接返回对应错误码；硬拦截拒绝时账本已留 `blocked` 行（供审计“谁在何时被拒”）。

若请求在已预留后、但 New API 调用失败：

- `release(requestId, "failed", errorCode, errorMessage)` 释放预留，账本行置 `failed` 并记录错误码与摘要（超长截断至 500 字符）；New API 返回非 200 亦同。

若客户端主动取消流：

- `release(requestId, "cancelled", ...)`，账本行置 `cancelled`；调用被中断同此处理。

`release` 幂等：只处理 `status='reserved'` 的账本行，重复调用直接返回。

### 11.6 软提醒提示语义

软提醒不是前端 toast 的名字，而是账务语义。系统必须做到：

- 兜底顺位放行时照常预留、照常转发，不向前端返回额度不足信息（对员工无感）；
- 结算时把超出“该池当月正常可用量”（`max(0, limit - consumed)`）的部分记入 `overage_tokens`，余额行与账本行都记；
- 兜底顺位当月无生效授权时 `limit` 视为 0，即本次消耗全部计超额；
- 报表（维度汇总、账本明细）必须能按超额 tokens 检索，供管理员事后调额。

是否在员工端额外提示“已超出额度”属于前端交互细节，可做，但不能代替记账。

***

## 12. API 设计

### 12.1 管理员 API

以下为最小 API 集。均要求 `SYSTEM_ADMIN` 角色，前缀 `/api/admin/llm`。

#### 企业模型

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/llm/models` | 模型列表 |
| POST | `/api/admin/llm/models` | 新建（校验网关模型名在 New API 清单中，§8.7） |
| PUT | `/api/admin/llm/models/{id}` | 编辑（网关模型名锁定，`LLM_GATEWAY_MODEL_LOCKED`） |
| POST | `/api/admin/llm/models/{id}/enable` | 启用 |
| POST | `/api/admin/llm/models/{id}/disable` | 停用 |
| DELETE | `/api/admin/llm/models/{id}` | 删除（有用量阻塞 `LLM_MODEL_IN_USE`，§8.7） |
| GET | `/api/admin/llm/newapi/models` | 拉取 New API 模型清单（网关模型名下拉数据源） |

#### 额度

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/llm/quota-grants` | 授权列表（可按 `modelId` 过滤） |
| POST | `/api/admin/llm/quota-grants` | 新建授权 |
| PUT | `/api/admin/llm/quota-grants/{id}` | 编辑授权 |
| POST | `/api/admin/llm/quota-grants/{id}/enable` | 启用 |
| POST | `/api/admin/llm/quota-grants/{id}/disable` | 停用 |

#### 用户模型路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/llm/routes` | 路由列表（含顺位项） |
| POST | `/api/admin/llm/routes` | 新建（同用户同模型唯一） |
| PUT | `/api/admin/llm/routes/{id}` | 编辑（顺位项整体替换） |

#### 用量分析

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/llm/usage/summary` | 维度汇总；`dimension=user/pool_user/pool_org_unit/model`，`month=YYYY-MM` |
| GET | `/api/admin/llm/usage/pool-users` | 池维度用户分解；`sourceType` / `sourceId` / `modelId` / `month=YYYY-MM`，按发起人聚合、总消耗倒序（授权列表点击池子下钻） |
| GET | `/api/admin/llm/usage/heatmap/year` | 近一年按天聚合热力图（§12.3） |
| GET | `/api/admin/llm/usage/ledger` | 账本明细分页；`month` / `userId` / `modelId` / `status` / `page` / `pageSize` |

### 12.2 员工端 API

均要求员工 JWT（`isAuthenticated()`），前缀 `/api/llm`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/llm/models` | 员工可用模型目录（含各额度池当月概况，§10.2） |
| POST | `/api/llm/v1/chat/completions` | 推理代理（OpenAI 兼容，流式/非流式，§10.3） |

### 12.3 热力图 API 返回格式

`GET /api/admin/llm/usage/heatmap/year`（无参数，固定近一年）返回按天聚合的全对象合计：

```json
{
  "code": 0,
  "data": [
    { "date": "2026-09-01", "totalTokens": 120000, "requestCount": 356 },
    { "date": "2026-09-02", "totalTokens": 80000, "requestCount": 240 }
  ]
}
```

后端只回有消耗的日期（仅统计 completed）；前端渲染 GitHub 风格年度热力图（列=周、行=星期、月份标签、Less→More 图例），并把 token 值按年度峰值比例映射为色阶档位，不在后端预先离散化。悬浮格子展示当天消耗与请求数。

***

## 13. New API 集成细节

### 13.1 推理代理客户端

`web-console` 后端需要一个 New API 推理客户端，特点如下：

```json
{
  "model": "gpt54-enterprise",
  "stream": true,
  "stream_options": { "include_usage": true },
  "user": "<platform_users.id>",
  "messages": []
}
```

说明：

- 请求体由员工端请求透传而来，仅改写 `model` 为网关模型名（`prepareOutgoing`），其余字段（含 `user`）原样转发；
- 认证用内部服务令牌（`Authorization: Bearer <NEWAPI_SERVICE_TOKEN>`），与员工身份无关，员工身份由额度控制层在预留时校验；
- 目标 URL 为 `NEWAPI_BASE_URL + /v1/chat/completions`；
- 流式请求强制 `stream_options.include_usage=true`（§10.4）；
- 错误处理：连接失败 / 非 200 → `LLM_GATEWAY_CALL_FAILED` 502，并幂等释放预留。

### 13.2 New API 与本系统账本的关系

系统必须坚持以下原则：

- New API 只是“协议与渠道适配层”，企业语义（谁、用哪个企业模型、走哪条路由、扣哪个池）全部由本系统决定；
- 内部服务令牌保持额度不限、全模型；任何在 New API 侧配置配额/分组倍率限制的行为都会绕过路由链与账本，属于实现违规；
- New API 的请求 ID（`X-Oneapi-Request-Id`）只作辅助对账，不作为结算依据；
- 不从 New API 后台抄数做统计（§15.1）。

***

## 14. 安全与权限

### 14.1 权限

权限模型（与实现一致）：

- 管理端 API（前缀 `/api/admin/llm`）：`@PreAuthorize("hasRole('SYSTEM_ADMIN')")`，模型、授权、路由、用量分析四个 Controller 统一要求 `SYSTEM_ADMIN` 角色；
- 员工端 API（前缀 `/api/llm`）：`@PreAuthorize("isAuthenticated()")`，任何登录员工可获取自己可用的模型目录并发起推理；
- 员工端只读自己的额度池概况（§10.2 `pools`），无任何管理能力；管理端与员工端共用同一个 Supabase JWT 验签链路。

### 14.2 密钥管理

必须区分以下三类密钥：

| 密钥 | 存放位置 | 用途 | 约束 |
| --- | --- | --- | --- |
| 内部服务令牌（`newapi.service-token`） | web-console 后端配置注入，不入库、不下发前端 | 推理转发与模型清单拉取（§13.1） | 必须对应 New API 中额度不限、永不过期的令牌 |
| 上游渠道 Key（真实 provider 的 key） | 仅 New API 控制台渠道配置 | New API 调用上游 provider | 本系统不存储、不经手、不下发 |
| 员工 JWT | 员工本地，随请求携带 | 身份认证与额度判定 | 不用于访问 New API，不透传给上游 |

员工端永远接触不到前两类密钥；泄露内部服务令牌等于绕过全部额度控制，按最高敏感级保管。

### 14.3 日志

日志脱敏要求：

- 账本（`llm_usage_ledger`）不落 prompt 与响应正文，只记 token 数、估算成本、错误码与错误摘要；
- 错误摘要 `error_message` 超长截断至 500 字符后入库；
- 服务端日志不打印员工消息内容、内部服务令牌与上游渠道信息；
- 账本行中的 DSH session ID（§10.3 请求头）仅用于按会话追溯，不含会话内容。

若需调试 prompt，只允许在受控环境下开启脱敏日志，并必须单独评审。

***

## 15. 统计与热力图口径

### 15.1 统计真相源

热力图与所有后台统计都直接从 `llm_usage_ledger` 聚合，不从 New API 后台抄数。

管理端"用量分析"页的热力图为近一年 GitHub 风格年度视图（全对象按天聚合，不区分维度；维度切换只影响汇总表），取色按当日合计占近一年峰值的比例分档。

### 15.2 统计维度

系统必须支持以下切片（`GET /api/admin/llm/usage/summary`，`dimension` 参数）：

| 维度 | 聚合依据 | 名称来源 |
| --- | --- | --- |
| `user` | 账本 `user_id`（发起调用的员工，谁在用） | `platform_users.display_name` |
| `pool_user` | 账本 `source_id` 且 `source_type='user'`（实际入账的个人池） | `platform_users.display_name` |
| `pool_org_unit` | 账本 `source_id` 且 `source_type='org_unit'`（实际入账的部门池） | `org_units.name` |
| `model` | 账本 `model_id` | `llm_enterprise_models.display_name` |

所有维度均按 `usage_month`（YYYY-MM）过滤，仅统计 `status='completed'` 的账本行，聚合输出 tokens / prompt_tokens / completion_tokens / overage_tokens / request_count。账本明细（§12.1 `usage/ledger`）与热力图（§12.3）为固定补充视图。

### 15.3 用户与部门归属口径

调用已经命中了来源，因此「池被消耗」口径按"本次调用实际入账来源"统计：走个人池入账记到个人池（`pool_user`），走部门池入账记到部门池（`pool_org_unit`），软提醒超额同样记在兜底顺位对应来源头上。个人池维度含其他用户路由借用的量；部门池维度含外部借用量、不含本部门员工走个人池的量。

同时，为了支持"谁用了多少"，ledger 也始终保存发起调用的 `user_id`，构成「谁在用」口径（`user` 维度）：这个员工这个月一共消耗了多少（不管走的自己的池还是部门的池），明细可下钻到每次调用（账本行同时带 `user_id` 与来源 `source_type`/`source_id`）。

员工与部门为多对多关系（一个员工可属多个部门，`org_unit_members`），因此不提供「部门员工合计用量」口径——多对多下该口径要么重复计入多个部门、要么需要引入无业务依据的主部门概念。

两类口径不冲突：同一条账本行在 `pool_user`/`pool_org_unit` 汇总里计入池归属者，在 `user` 汇总里计入发起员工。

***

## 16. 失败码建议

建议标准化以下错误码：

| 错误码                          | 含义                                        |
| ---------------------------- | ----------------------------------------- |
| `LLM_MODEL_REQUIRED`         | 推理请求缺少 model 字段                           |
| `LLM_MODEL_NOT_FOUND`        | 模型不存在（或已停用/对当前用户不可见）                      |
| `LLM_GATEWAY_MODEL_EXISTS`   | 网关模型名已存在（409）                             |
| `LLM_GATEWAY_MODEL_NOT_IN_NEWAPI` | 网关模型名在 New API 模型清单中不存在，创建被拒绝（400）      |
| `LLM_NEWAPI_UNAVAILABLE`     | New API 不可达或响应异常，模型清单拉取失败，保存被阻塞（502）        |
| `LLM_NEWAPI_UNCONFIGURED`    | 未配置 `NEWAPI_SERVICE_TOKEN`，无法拉取模型清单（503）        |
| `LLM_GATEWAY_MODEL_LOCKED`   | 网关模型名创建后不可修改，变更被拒绝（400）                     |
| `LLM_MODEL_IN_USE`           | 模型已有用量账本记录，不可物理删除，提示改用停用（409）               |
| `LLM_GRANT_NOT_FOUND`        | 额度授权不存在                                   |
| `LLM_ROUTE_NOT_FOUND`        | 路由不存在                                     |
| `LLM_ROUTE_NOT_CONFIGURED`   | 当前用户无该模型的可用路由（未分配任何额度来源）                 |
| `LLM_SUBJECT_NOT_FOUND`      | 路由主体（用户/部门）不存在                            |
| `LLM_QUOTA_EXHAUSTED`        | 路由链全部额度来源耗尽且策略为硬拦截                        |
| `LLM_GATEWAY_CALL_FAILED`    | 推理转发调用 New API 失败（502）                    |
