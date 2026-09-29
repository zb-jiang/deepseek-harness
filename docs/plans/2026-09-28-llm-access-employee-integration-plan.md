# LLM 配额员工端集成实施方案（llm-access 企业包）

日期：2026-09-28
状态：待评审
上游设计：`2026-09-27-enterprise-llm-quota-design.md` §6.3 / §10（本文档实现其"员工端（规划中）"部分）
前置事实：web-console 服务端两端点已实现——`GET /api/llm/models`（员工模型目录）、`POST /api/llm/v1/chat/completions`（推理代理，OpenAI 兼容，流式/非流式）

## 0. 一句话概述

新建企业包 `packages/enterprise/llm-access/`：在本地 DSH webserver（127.0.0.1:3080）注册 `/api/enterprise/llm/*` 代理路由（带用户 JWT 转发 web-console），并以"自定义 LlmAdapter + 运行时 provider 注册"把企业模型目录动态追加进 DSH 现有模型选择器，企业模型的推理请求经本地代理链路转发，自配 provider 路径零改动。

## 1. 目标与边界

交付结果必须满足上游设计 §10.5 的五条：

1. 模型列表**合并非替换**：企业模型追加在现有列表末尾，员工下拉只按 displayName 平铺，不展示路由池与余量；
2. 按当轮选中模型**分流请求出口**：企业模型 → `POST /api/llm/v1/chat/completions`（经本地 webserver 代理）；自配 provider → 原有直连路径完全不变；
3. web / desktop 两种形态走同一条代理链路（页面 → 本地 webserver → web-console → New API）；
4. 错误码映射为员工可读文案（仅企业模型路径）；
5. 不暴露 New API 地址、内部服务令牌与上游渠道信息。

边界：不改 `packages/core`、`packages/llm` 等通用包（只消费其公开扩展点）；不动员工自配 provider 的配置与选择机制；企业代码落点为 `packages/enterprise/llm-access/`、`packages/bundle/enterprise-app/`、`apps/web-console`（小改，见 §5.3）。

## 2. 总体架构

```
【模型目录链路】（登录后/定时）
llm-access 插件（DSH 后台进程）
  → GET http://127.0.0.1:3080/api/enterprise/llm/models   （本地代理路由）
    → GET {webConsoleBaseUrl}/api/llm/models               （附用户 JWT）
      ← [{id, gatewayModelName, displayName, contextWindow?, maxTokens?}]
  → 缓存清单 → 注册/刷新 provider 'llm-enterprise' 的模型列表
  → 触发模型目录刷新（llm/adapters-updated 事件链）
  → 模型选择器出现「企业模型」分组（追加在末尾）

【推理链路】（选中企业模型的那轮对话）
agent loop → LlmRuntime.stream → llm-enterprise 的 adapter
  → POST http://127.0.0.1:3080/api/enterprise/llm/v1/chat/completions
     （OpenAI 兼容体，model=gatewayModelName，SSE 透传）
    → web-console 额度控制层（预留 → New API → 按 usage 结算）
      ← SSE 流原样透传回 adapter → 聊天 UI 打字机渲染
```

自配 provider 的推理不经以上任何环节：selection.provider ≠ `llm-enterprise` 时走原有 adapter 分发，零改动。

## 3. 关键设计决策

### D1：企业 provider 用"自定义 LlmAdapter + 运行时注册"，不写静态配置

企业模型目录是运行时数据（管理员可随时启停模型、改授权），不能进 cordis.yml 静态 models 数组。方案：

- llm-access 包实现一个 `LlmAdapter`（OpenAI 兼容语义），`listModels(provider)` 覆盖为读本地缓存的企业模型清单（源头 §2 目录链路）；
- provider 记录通过 `LlmRuntime` 的运行时注册 API（`registerConfigurableProviders`，见 §4-2）注入，id 定为 `llm-enterprise`（与 `llm-deepseek` 命名对齐）；若该 API 语义不适合（组 0 验证），回退方案：cordis.patch.yml 声明静态 provider 条目（baseURL 指向本地路由、占位 apiKey、models 留空），仅靠 adapter 的 `listModels` 提供动态清单。

员工零配置：不需要在设置里添加任何 provider 凭据。

### D2：请求出口 = adapter 发往本地 webserver 代理路由，JWT 由代理层注入

adapter 的 baseURL 指向 `http://127.0.0.1:3080/api/enterprise/llm/v1`（同进程的本地 webserver）。代理路由处理器照抄 knowledge 包模式：从当前会话取用户 Supabase JWT，替换 Authorization 头后转发 web-console。adapter 自身不持有任何凭据（对本地路由无需真实 apiKey；占位值即可），天然满足"员工端接触不到内部服务令牌"。

待验证（组 0）：代理路由处理器如何解析"发起这轮对话的用户"。knowledge 的 `options.token()` 走 `ctx.currentUser`，其作用域是否覆盖 agent loop 触发的非浏览器请求（server-to-local-server）需要确认；若不可达，备选是 adapter 在请求上下文内直接从 enterprise 会话服务取 token 附到发往本地路由的请求头（本地路由优先采信传入 JWT）。

### D3：模型目录动态拉取 + 事件驱动刷新

- 拉取时机：插件启动后首次拉取；登录态变化后拉取；此后定时刷新（默认 10 分钟，`Config` 可配）。
- 失败降级：web-console 不可达时保留上一次清单（首次失败则不注册企业分组，选择器不出现该组，静默重试）；不阻断 DSH 启动。
- 清单更新后触发模型目录刷新（对齐 `llm/adapters-updated` / settings 更新事件的既有刷新链，见 §4-3）。
- 目录字段映射：`ModelInfo.id = gatewayModelName`（请求体的 `model` 值，服务端按它路由），`name = displayName`；`pools`/`exhaustAction` 不进 UI（上游 §10.2 明确）。

### D4：流式优先复用现有 OpenAI 兼容实现

若 `packages/llm/` 已有可组合的 OpenAI 兼容 adapter（SSE 解析、chat completion 请求构造），我们的 adapter 以组合方式复用（换 baseURL + 免凭据 + 注入 JWT/会口头）；没有可复用件则在 llm-access 内实现 SSE 解析（只做透传 + 错误识别，不改动事件内容，满足上游 §10.4"原样透传"）。组 0 盘点后定。

### D5：错误文案映射在 adapter 层

web-console 返回 409 `LLM_QUOTA_EXHAUSTED` / 403 `LLM_ROUTE_NOT_CONFIGURED` 等错误码 JSON（上游 §16）。adapter 捕获后转换为用户可读消息抛出（`LLM_QUOTA_EXHAUSTED` → "本月额度已用完"、`LLM_ROUTE_NOT_CONFIGURED` → "未分配模型权限"，其余透传 message）；`LlmRuntime.stream` 已把 adapter 异常转为 terminal `finish/error` chunk 呈现到聊天 UI（见 §4-6），无需改 UI。

### D6：会话追溯头尽力而为

上游 §10.3 允许请求头 `X-DSH-Session-Id`（写账本便于按会话追溯）。adapter 若能在请求上下文拿到当前 session id 则注入；拿不到不阻塞（该头可选）。组 0 顺带确认。

## 4. 已核实的扩展点与先例（实施依据）

| # | 事实 | 位置 |
|---|---|---|
| 1 | 模型选择器消费共享 catalog：`ModelDirectory.load()` → Host/Remote catalog；groups 直接写入选择器状态 | `packages/client/ui-model-selection/src/client/directory.ts` L72-77、L141-178 |
| 2 | catalog 服务端聚合：遍历 `ctx.llm.listProviders()`，逐 provider 调 `ctx.llm.listModels()` 生成 groups——企业模型进了 `listModels` 就进了选择器 | `packages/api/session-controller/src/catalog.ts` L19-70 |
| 3 | 选中模型校验同源：provider 存在 + model 在 `listModels` 结果中，否则判 `session/model-unavailable`——动态清单必须被 `listModels` 返回 | `session-controller/src/catalog.ts` L79-89 |
| 4 | `LlmAdapter.listModels(provider)` 默认空，adapter 可覆盖提供动态目录 | `packages/llm/llm/src/index.ts` L240-250 |
| 5 | `LlmRuntime` 维护 adapter registry / configurable provider directory / model discovery registry；`registerConfigurableProviders` 允许运行时声明 provider | `packages/llm/llm/src/index.ts` L338-348、L490-543 |
| 6 | 推理分发：按 `options.provider` 找 adapter registration → `adapter.prepareCall()` → `adapterCall.stream()` | `packages/llm/llm/src/index.ts` L1033-1089 |
| 7 | `LlmRuntime.stream` 经 `llm/stream` waterfall，adapter 异常转 terminal `finish/error` chunk（错误到 UI 的入口） | `packages/llm/llm/src/index.ts` L1135-1160 |
| 8 | 目录刷新事件链：`llm/adapters-updated`、`settings/document-updated`、`credentials/*-updated` 触发 catalog refresh | `packages/client/ui-model-selection/src/client/service.ts` L45-57 |
| 9 | 本地 webserver 前缀路由先例（含 volatile config 读取 + 转发 + JWT 替换）：knowledge 包 `/api/enterprise/kb`、`/api/enterprise/apps` → web-console，token 取 `ctx.currentUser.getToken()`，`webConsoleBaseUrl` 每请求动态读 | `packages/enterprise/knowledge/src/index.ts`（proxyRequest 函数） |
| 10 | 纯转发先例：flowable-task-proxy 用 `ctx.webServer.register({kind:'prefix', path, handler})` | `packages/enterprise/flowable-task-proxy/src/index.ts` |
| 11 | bundle 组装：enterprise-app 的 cordis.patch.yml 声明插件条目 + config（`!!js process.env.WEB_CONSOLE_URL ?? 'http://127.0.0.1:8080'`） | `packages/bundle/enterprise-app/cordis.patch.yml` |
| 12 | 远端模型发现先例（供 D4 参考组合可能）：llm-pi-ai 的 discovery 调 `/models`、`/v1/models` 解析 `LlmDiscoveredModel` | `packages/llm/llm-pi-ai/src/discovery.ts` L269-363 |

## 5. 落点清单

### 5.1 新包 `packages/enterprise/llm-access/`

```
packages/enterprise/llm-access/
  package.json          @deepseek-ai/dsh-llm-access；依赖声明照抄 knowledge
                        （@deepseek-ai/dsh-llm 走 peer/dev，workspace 规则见根 AGENTS.md）
  src/
    index.ts            definePlugin：Config（webConsoleBaseUrl / 刷新间隔 / 超时）
                        + 注册 webserver 路由 + 启动目录拉取 + 定时刷新
    proxy.ts            /api/enterprise/llm/* 前缀路由（照抄 knowledge 的 proxyRequest：
                        JWT 注入、baseURL 动态读、SSE 流式 pipe 转发——不缓冲整体响应）
    catalog.ts          企业模型目录拉取 + 缓存 + 失败降级；字段映射（D3）
    adapter.ts          LlmAdapter 实现：listModels 读缓存；stream/prepareCall 发往
                        本地路由（D2/D4）；错误映射（D5）；X-DSH-Session-Id（D6）
    provider.ts         provider 记录构造与运行时注册（D1 主路径；组 0 后定稿）
  README.md             契约：config 字段、路由清单、边界（不碰自配 provider）
```

### 5.2 `packages/bundle/enterprise-app/cordis.patch.yml`

追加插件条目：

```yaml
- id: llm-access
  name: '@deepseek-ai/dsh-llm-access'
  config:
    webConsoleBaseUrl: !!js process.env.WEB_CONSOLE_URL ?? 'http://127.0.0.1:8080'
    refreshIntervalMs: !!js Number(process.env.LLM_CATALOG_REFRESH_MS ?? 600000)
```

（若 D1 走回退方案，此处另加静态 provider 条目。）

### 5.3 web-console 小改（企业代码，允许）

**模型目录补上下文参数**：DSH 的 `ModelInfo`/`LlmDiscoveredModel` 需要 `contextWindow`/`maxTokens`（§4-2/§4-3 的 catalog 聚合与选中校验都消费它们），而现有 `GET /api/llm/models` 返回体（上游 §10.2）只有 `id/gatewayModelName/displayName/exhaustAction/pools`。改法：`model_params_json`（建表已有，jsonb）约定可存 `contextWindow`/`maxTokens`，`LlmEmployeeService` 组装 `EmployeeModelDto` 时读出补字段；未配置时员工端兜底默认值（如 128000/8192）。同步在模型管理页编辑弹窗补这两个输入框（或先约定直接写库，界面后补——与上游 §9.2 单价字段的"界面未暴露"处理一致）。

### 5.4 ui-enterprise

预期**零改动**：模型选择器、目录、选中校验全部走共享机制（§4-1~3），企业分组自动出现。仅当组 0 发现分组显示名/排序需要干预时才有小改（见 §8-4）。

## 6. 实施拆解

### 组 0：扩展点核实（半天，其余组的前置）

| # | 验证项 | 判定 |
|---|---|---|
| 0-1 | `LlmAdapter` 接口完整形状与注册 API（符号名、注册时机、与 provider 记录的关联方式） | 读 `packages/llm/llm/src/index.ts`、`types.ts` |
| 0-2 | `registerConfigurableProviders` 签名与语义（能否与 adapter 动态 listModels 组合；注册进的东西会不会出现在用户设置编辑器里） | 同上 + ui-settings-models 消费面 |
| 0-3 | D2 的 token 可达性：agent loop 触发的 adapter 调用里，`ctx.currentUser`/会话服务能否取到发起用户 JWT；两条路（代理层解析 vs adapter 注入）选一 | knowledge 的 token 来源 + webserver 会话中间件 |
| 0-4 | D4 组合可能：llm 包是否导出可复用的 OpenAI 兼容请求构造/SSE 解析（盘点 `packages/llm/` 子包清单） | 决定 adapter 自研量 |
| 0-5 | catalog 分组的显示名与排序来源（provider id？display name？注册顺序？） | session-controller catalog 聚合 + ModelSelect 渲染 |
| 0-6 | `llm/stream` waterfall 的 options 形状（是否携带 headers 可改写——D2 备选通道） | `packages/llm/llm/src/index.ts` L1135-1160 |

产出：本方案 D1/D2/D4 定稿（主路径或回退），必要时修订本节。

### 组 1：web-console 目录字段补充（可并行）

| # | 工作项 | 验证 |
|---|---|---|
| 1-1 | `model_params_json` 约定 `contextWindow`/`maxTokens`；`EmployeeModelDto` 补两字段 | 单测：配置/未配置两分支 |
| 1-2 | 模型管理页编辑弹窗补输入框（或记录"暂写库"决定） | 手工 |

### 组 2：本地代理路由（proxy.ts）

| # | 工作项 | 验证 |
|---|---|---|
| 2-1 | `/api/enterprise/llm/models` → `GET /api/llm/models`（JWT 注入、未登录 401、baseURL 无效 502，照抄 knowledge） | curl 本地路由带/不带登录态 |
| 2-2 | `/api/enterprise/llm/v1/chat/completions` → `POST` 同名（**SSE 流式 pipe 逐块转发**，禁止整体缓冲；非流式整体转发） | curl 流式请求，肉眼验证逐块到达；断连不挂起 |

### 组 3：adapter + provider + 目录（adapter.ts / catalog.ts / provider.ts）

| # | 工作项 | 验证 |
|---|---|---|
| 3-1 | catalog.ts：拉取/缓存/降级/定时刷新 + 字段映射 | 单测：正常/不可达保旧/首次失败空组 |
| 3-2 | adapter.ts：listModels 读缓存；请求构造（model=gatewayModelName）；SSE 消费（D4 结论落地）；错误映射（D5）；session 头（D6） | 单测：错误码映射表；模型 id 映射 |
| 3-3 | provider.ts + index.ts：运行时注册（D1 定稿路径）、事件触发目录刷新 | 启动后选择器出现企业分组 |

### 组 4：bundle 组装 + 端到端

| # | 工作项 | 验证 |
|---|---|---|
| 4-1 | cordis.patch.yml 追加条目（§5.2）；`pnpm install` 刷新 lockfile | profile 启动无错 |
| 4-2 | §7 手工验证清单全量走一遍 | 全过 |

## 7. 端到端手工验证清单

环境：本地 PG + web-console(:8080) + New API(:3000) + flowable-engine(:8090)；web-console 已配置至少一个企业模型（渠道→模型→授权→路由四件套齐）。

| # | 步骤 | 预期 |
|---|---|---|
| 1 | 员工登录 DSH（enterprise profile），打开模型选择器 | 「企业模型」分组追加在自配 provider 之后；只显示 displayName，无池/余量信息 |
| 2 | 选中企业模型发起对话 | 打字机流式渲染正常（SSE 透传） |
| 3 | 查 web-console 用量分析 | 该次调用账本行 `completed`，tokens/来源/顺位正确 |
| 4 | web-console 停用该模型，等刷新周期 | 员工端选择器该模型消失；选中态被清或提示不可用（对齐既有 model-unavailable 行为） |
| 5 | 耗尽额度（limit 调小）后发对话 | UI 显示「本月额度已用完」，无原始 409 JSON 裸奔 |
| 6 | 无路由用户选企业模型（未配路由） | UI 显示「未分配模型权限」 |
| 7 | 切回员工自配 provider 模型对话 | 原直连路径正常（回归） |
| 8 | web-console 停机时启动 DSH | DSH 正常起；选择器无企业分组；web-console 恢复后下个刷新周期出现 |
| 9 | desktop（Electron）形态重复 1-3 | 链路一致 |
| 10 | 抓包确认员工端进程 | 任何请求不出现 New API 地址/服务令牌/上游渠道信息 |

## 8. 风险与开放问题

1. **token 可达性（组 0-3）**：agent loop 上下文里取用户 JWT 若两条路都不通，最后手段是在 `llm/stream` waterfall 改写 headers（组 0-6 核实形状）；仍不通才考虑最小核心改动（届时单独评审，本文档不预设）。
2. **SSE 转发的背压与断连**（组 2-2）：本地代理必须逐块 pipe；客户端断连要中止上游请求（web-console 侧按 `cancelled` 释放预留——上游 §11.5，代理层只需不吞错误）。
3. **contextWindow 数据源头**：管理员建模型时不填则员工端兜底默认值，agent 上下文预算估算会不准（过长输入可能在 New API 侧报错）。组 1 做好后风险收敛为"管理员忘填"。
4. **分组排序**（组 0-5）：若 catalog 分组顺序按注册/字母序而非"追加在末尾"，需要在 llm-access 侧控制注册顺序或接受排序现状；上游 §10.5 要求"追加展示"，排序不可控时与上游文档对齐修订。
5. **目录刷新时延**：管理员启停模型后员工端最迟一个刷新周期（默认 10 分钟）生效；选中已消失模型的会话按既有 `model-unavailable` 语义处理，不额外做推送。
6. **并发首拉**：多会话同时冷启动时目录拉取并发——插件内单例缓存即可（拉取在插件层做一次，与会话无关）。

## 9. 与上游设计的差异登记

- §10.2 返回体新增 `contextWindow`/`maxTokens` 字段（§5.3，服务端小改）——实施后回写上游文档 §10.2 示例。
- `pools` 字段员工端不消费（上游已注明"可从 DTO 裁剪"）；本期保留服务端返回，前端忽略，裁剪留待上游决定。
- 本地路由前缀定为 `/api/enterprise/llm/*`（上游只写了员工端"经本地 webserver 代理"，未定前缀；对齐 knowledge 的 `/api/enterprise/` 命名）。
