# expense-sor API 清单（第三方应用对接）

expense-sor 是费控报销的记账系统（System of Record），对外提供报销单全生命周期 REST API。本文档面向第三方应用（流程引擎 delegate、财务系统、对账脚本等）。

- Base URL：`http://<host>:8091`（端口由 `SOR_PORT` 配置，默认 8091）
- 编码：UTF-8，请求/响应体均为 JSON（附件上传/下载除外）
- 认证：用户 JWT 或服务密钥，见 [认证方式](#认证方式)

## 认证方式

| 方式 | 请求头 | 适用端点 | 身份 |
|------|--------|----------|------|
| 用户 JWT | `Authorization: Bearer <token>` | 除免认证端点外全部 | JWT `sub`（Supabase 用户 UUID） |
| 服务密钥 | `X-Service-Key: <key>` | 仅下表 5 个白名单端点 | 服务身份（无用户），操作人以请求体携带值为准 |
| 免认证 | 无 | `GET /api/health`、`GET /api/ui-config` | - |

JWT 为 Supabase Auth 签发的 ES256 token，服务端从 JWKS 地址拉公钥本地验签，校验签名/`exp`/`iss`，不校验 `aud`。

**服务密钥端点白名单**（其余端点仅接受用户 JWT，仅带服务密钥的请求一律 401）：

| 方法 | 路径 |
|------|------|
| GET | `/api/expenses/{id}` |
| PUT | `/api/expenses/{id}/status` |
| PUT | `/api/expenses/{id}/process-instance` |
| POST | `/api/expenses/{id}/approval-records` |
| POST | `/api/expenses/{id}/payment` |

同时携带 JWT 与服务密钥时以 JWT 为准。JWT 调用时请求体中的 `approverId`/`paidBy` 必须等于 JWT `sub`，否则 403。

## 统一响应约定

成功（除标注「裸响应」外）统一包裹信封：

```json
{ "code": 0, "data": { ... } }
```

失败（所有错误均为裸信封，不包 `data`）：

```json
{ "code": 1409, "message": "状态迁移非法", "details": { "current": "opened" } }
```

**通用格式约定**：

- 金额：字符串，正数十进制，最多两位小数，如 `"1500.00"`；响应中金额同样为字符串（`totalAmount`、`amount`）
- 日期：`yyyy-MM-dd`；时间：ISO-8601（如 `2026-09-24T10:30:00+08:00`）
- id 均为 UUID 字符串

**错误码汇总**：

| HTTP | code | 含义 | 典型场景 |
|------|------|------|----------|
| 400 | 1400 | 请求参数错误 | 字段缺失/格式非法、附件超 10MB |
| 401 | 1401 | 未认证 | JWT 无效/过期、X-Service-Key 无效、端点仅接受 JWT |
| 403 | 1403 | 禁止 | `approverId`/`paidBy` 与 JWT sub 不符、非提交人撤回 |
| 404 | 1404 | 资源不存在 | 报销单/附件不存在 |
| 409 | 1409 | 冲突 | 状态迁移非法（`ILLEGAL_STATE_TRANSITION`）、重复打款、流程实例 id 冲突（`PROCESS_INSTANCE_CONFLICT`） |
| 500 | 1500 | 服务内部错误 | 数据库访问失败等 |

## 状态机

报销单状态：`opened`（已提交）→ `ongoing`（审批中）→ `approved`（已批准）→ `paid`（已打款）；任一审批拒绝 → `rejected`；`ongoing`/`approved` 阶段可撤回 → `cancelled`。`paid`/`rejected`/`cancelled` 为终态。

**合法迁移矩阵**（非法迁移一律 409）：

| 当前态 | 可迁移到 | 迁移触发方式 |
|--------|----------|--------------|
| opened | ongoing / approved / rejected | 审批记录联动（approve+targetStatus / reject） |
| ongoing | approved / rejected / cancelled | 审批记录联动；撤回 |
| approved | paid / cancelled | 打款写入联动；撤回 |
| opened / rejected / paid / cancelled | -（不可撤回） | - |

建单即 `opened`。状态迁移入口收敛在 SOR 内部：正常推进走审批记录/打款端点的联动迁移，`PUT /{id}/status` 仅为管理备用入口。

## 端点一览

| # | 方法 | 路径 | 认证 | 说明 |
|---|------|------|------|------|
| 1 | GET | `/api/health` | 无 | 健康检查（裸响应） |
| 2 | GET | `/api/ui-config` | 无 | Supabase 客户端配置 |
| 3 | GET | `/api/me` | JWT | 当前登录用户信息 |
| 4 | POST | `/api/expenses` | JWT | 创建报销单 |
| 5 | POST | `/api/expenses/attachments` | JWT | 上传附件（multipart） |
| 6 | GET | `/api/expenses` | JWT | 报销单列表（分页） |
| 7 | GET | `/api/expenses/{id}` | JWT / Key | 查询报销单完整信息 |
| 8 | GET | `/api/expenses/{id}/attachments/{attachmentId}` | JWT | 下载附件（二进制，裸响应） |
| 9 | PUT | `/api/expenses/{id}/status` | JWT / Key | 显式状态迁移（管理备用） |
| 10 | POST | `/api/expenses/{id}/approval-records` | JWT / Key | 写审批记录（联动迁移，幂等） |
| 11 | POST | `/api/expenses/{id}/payment` | JWT / Key | 写打款记录（联动迁移 paid） |
| 12 | POST | `/api/expenses/{id}/cancel` | JWT | 撤回报销单 |
| 13 | PUT | `/api/expenses/{id}/process-instance` | JWT / Key | 回写流程实例 id（幂等） |

## 端点详情

### 1. GET /api/health

免认证。裸响应：`{ "status": "UP" }`

### 2. GET /api/ui-config

免认证。返回 Supabase 项目 URL 与 anon key（设计上公开的浏览器端客户端密钥），供前端直连认证中心登录。

```json
{ "code": 0, "data": { "supabaseUrl": "https://xxx.supabase.co", "supabaseAnonKey": "eyJ..." } }
```

### 3. GET /api/me

仅 JWT。当前用户信息；`displayName` 按 `platform_users.auth_subject` 匹配，查不到为 null。

```json
{ "code": 0, "data": { "sub": "uuid", "email": "a@b.c", "displayName": "张三" } }
```

### 4. POST /api/expenses（创建报销单）

仅 JWT，创建人 = JWT `sub`，创建即 `opened`。`totalAmount` 由服务端按明细求和，不信任调用方传值；币种固定 CNY。

请求：

```json
{
  "title": "出差报销",
  "reason": "北京客户现场支持 3 天",
  "submitterName": "张三",
  "items": [
    { "category": "交通费", "amount": "1200.50", "occurredDate": "2026-09-20", "description": "高铁往返" },
    { "category": "住宿费", "amount": "900.00", "occurredDate": "2026-09-21", "description": "酒店 2 晚" }
  ],
  "attachmentIds": ["<先经端点 5 上传得到的附件 UUID>"]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| title | 是 | 单据标题 |
| reason | 是 | 报销事由 |
| submitterName | 是 | 提交人姓名 |
| items | 是 | 明细行，至少 1 条；`category`/`description` 非空，`amount` 正数两位小数字符串，`occurredDate` 为 yyyy-MM-dd |
| attachmentIds | 否 | 附件 UUID 列表；附件须已上传且未关联其他单据，否则 400 |

响应 `data`：ExpenseDetailDto。

### 5. POST /api/expenses/attachments（上传附件）

仅 JWT。`multipart/form-data`，字段名 `file`。单个 ≤ 10MB；类型仅 pdf/png/jpeg。附件先独立上传（不属于任何单据），建单时通过 `attachmentIds` 关联。

响应 `data`：AttachmentMetaDto。

### 6. GET /api/expenses（报销单列表）

仅 JWT。按 `createdAt` 倒序分页。

| 参数 | 必填 | 说明 |
|------|------|------|
| status | 否 | 按状态过滤（opened/ongoing/approved/rejected/paid/cancelled） |
| submitterId | 否 | 按提交人 UUID 过滤 |
| offset | 否 | 偏移量，默认 0 |
| limit | 否 | 条数，默认 50，上限 200 |

响应 `data`：ExpenseSummaryDto 数组。

### 7. GET /api/expenses/{id}（查询报销单）

JWT 或服务密钥。响应 `data`：ExpenseDetailDto（含明细、附件元数据、审批记录、打款记录）。

### 8. GET /api/expenses/{id}/attachments/{attachmentId}（下载附件）

仅 JWT（不在服务密钥白名单）。二进制流，`Content-Disposition: attachment`；校验附件归属该单据，不归属返回 404。裸响应。

### 9. PUT /api/expenses/{id}/status（显式状态迁移）

JWT 或服务密钥。管理备用入口，按迁移矩阵校验。

```json
{ "from": "opened", "to": "ongoing", "reason": "流程引擎启动" }
```

- `from` 与单据当前态不一致：409，`details.current`/`details.expected` 携带实际与期望状态
- `to` 不在当前态合法目标集：400，消息列出允许值
- `to=cancelled`：需要 JWT 且为提交人本人（服务密钥无法迁移到 cancelled）
- 响应 `data`：ExpenseDetailDto

### 10. POST /api/expenses/{id}/approval-records（写审批记录）

JWT 或服务密钥。审批审计数据源，同一单据可多条；**落库联动状态迁移**：`reject` → `rejected`；`approve` 按请求 `targetStatus` 定目标（缺省 `ongoing`，最后审批节点传 `approved`）。

```json
{
  "processInstanceId": "<流程实例 UUID>",
  "activityId": "financeVerify",
  "decision": "approve",
  "targetStatus": "approved",
  "comment": "复核通过",
  "approverId": "<审批人 UUID>",
  "approverName": "李四"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| processInstanceId | 是 | 关联流程实例 id |
| activityId | 是 | BPMN 节点 id |
| decision | 是 | 仅 `approve` / `reject` |
| targetStatus | 否 | approve 时生效：`ongoing`（缺省）/ `approved`；reject 时忽略 |
| comment | 否 | 审批意见 |
| approverId | 是 | JWT 调用时必须 = JWT `sub`（否则 403）；服务密钥调用以请求体为准 |
| approverName | 是 | 审批人姓名 |

**幂等**：同一单据 + processInstanceId + activityId + decision 重复提交不重复落库、不重复迁移，响应 `duplicated: true`。

响应 `data`：

```json
{ "id": "<记录 UUID 或 null>", "duplicated": false }
```

### 11. POST /api/expenses/{id}/payment（写打款记录）

JWT 或服务密钥。前置条件：单据状态必须 `approved`（否则 409）。一单最多一条打款记录，重复调用 409；**写入即联动迁移 `paid`**。

```json
{
  "amount": "2100.50",
  "channel": "bank",
  "comment": "8 月报销批次",
  "paidBy": "<打款人 UUID>",
  "paidName": "王五"
}
```

`paidBy`：JWT 调用时必须 = JWT `sub`；服务密钥调用以请求体为准。响应 `data`：PaymentDto。

### 12. POST /api/expenses/{id}/cancel（撤回）

仅 JWT，仅提交人本人（否则 403），仅 `ongoing`/`approved` 状态可撤（否则 409）。响应 `data`：ExpenseDetailDto。

### 13. PUT /api/expenses/{id}/process-instance（回写流程实例 id）

JWT 或服务密钥。一单只关联一个流程实例。

```json
{ "processInstanceId": "<流程实例 UUID>" }
```

- 首次写入：`{ "id": "...", "processInstanceId": "...", "firstWrite": true }`
- 重复回写同一 id：幂等返回 200，`firstWrite: false`
- 回写不同 id：409，`details.current`/`details.incoming` 携带已有关联与传入值

## 数据模型

**ExpenseDetailDto**（创建/查询/迁移/撤回响应）：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 报销单 UUID |
| title / reason | string | 标题 / 事由 |
| totalAmount | string | 合计金额（服务端计算） |
| currency | string | 币种，固定 `CNY` |
| status | string | opened / ongoing / approved / rejected / paid / cancelled |
| submitterId / submitterName | string | 提交人 UUID / 姓名 |
| processInstanceId | string \| null | 关联流程实例 id（回写前为 null） |
| items | ExpenseItemDto[] | 明细行 |
| attachments | AttachmentMetaDto[] | 附件元数据 |
| approvalRecords | ApprovalRecordDto[] | 审批记录（按时间正序） |
| payment | PaymentDto \| null | 打款记录（未打款为 null） |
| createdAt / updatedAt | string | ISO-8601 时间 |

**ExpenseSummaryDto**（列表条目）：上述字段去掉 items/attachments/approvalRecords/payment/updatedAt。

**ExpenseItemDto**：`id`、`category`、`amount`（字符串）、`occurredDate`（yyyy-MM-dd）、`description`。

**AttachmentMetaDto**：`id`、`fileName`、`contentType`、`sizeBytes`、`uploadedBy`、`createdAt`。

**ApprovalRecordDto**：`id`、`reportId`、`processInstanceId`、`activityId`、`decision`、`comment`、`approverId`、`approverName`、`createdAt`。

**PaymentDto**：`id`、`reportId`、`amount`（字符串）、`channel`、`comment`、`paidBy`、`paidName`、`paidAt`。

## 典型对接序列（流程引擎 delegate）

```
建单(员工 JWT) ──► 回写 process-instance ──► 流程审批节点逐个写 approval-records
    │                (端点 13, firstWrite)       │  中间节点: approve, targetStatus 缺省 → ongoing
    │                                            │  最后节点: approve, targetStatus=approved → approved
    │                                            └  任一 reject → rejected(终态)
    └─► 审批链全部通过后,出纳写 payment(端点 11) → paid(终态)
```

## 调用示例

服务密钥写审批记录（curl）：

```bash
curl -X POST http://127.0.0.1:8091/api/expenses/3f1c.../approval-records \
  -H "X-Service-Key: <SOR_SERVICE_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"processInstanceId":"b0c8...","activityId":"directLeaderAudit","decision":"approve","approverId":"5a2b...","approverName":"李四"}'
```

用户 JWT 建单（PowerShell）：

```powershell
$body = [Text.Encoding]::UTF8.GetBytes('{"title":"出差报销","reason":"客户现场支持","submitterName":"张三","items":[{"category":"交通费","amount":"1200.50","occurredDate":"2026-09-20","description":"高铁往返"}]}')
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8091/api/expenses `
  -Headers @{ Authorization = "Bearer <token>" } `
  -ContentType "application/json; charset=utf-8" -Body $body
```
