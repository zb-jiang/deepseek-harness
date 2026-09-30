# 把一套 HTTP API 包装成 DSH AI 工具包（Bundle）——第三方实施教程

| 项 | 内容 |
| --- | --- |
| 读者 | 受雇做系统集成的开发人员（只需要大一计算机基础知识） |
| 目标 | 拿到一份系统的 `API.md` 接口文档后，独立产出一个可安装的 DSH 工具包（bundle），并交付给平台方 |
| 阅读时间 | 约 40 分钟；跟着做约 1~2 天 |
| 前提 | 会一点 JavaScript/TypeScript，会用命令行；其他一律从零讲 |

---

## 0. 这份教程教你做什么

想象一个场景：某公司有一个内部业务系统（比如报销系统），它对外提供了一堆 HTTP 接口（就是 `API.md` 里写的那些 `GET /xxx`、`POST /xxx`）。现在公司希望员工能直接对 AI 助手说"帮我查一下我最近的报销单"，AI 就去调这些接口完成操作。

**你要做的，就是在中间造一座"桥"**：

```
员工说话："帮我查报销单"                        （自然语言）
      ↓
DSH 桌面平台里的 AI，选择调用一个"工具"           （AI 只认识"工具"，不认识 HTTP）
      ↓
你写的工具包：把"工具调用"翻译成 HTTP 请求发出去    （★ 这就是你要写的东西 ★）
      ↓
业务系统收到请求，返回 JSON
      ↓
你的工具包把结果翻译成人话，AI 转述给员工
```

用餐厅打比方：**业务系统是后厨，HTTP 接口是后厨的传菜口，AI 是服务员，你写的工具包就是"菜单"**——服务员只会看菜单点菜（工具名 + 参数），你的工作是把菜名翻译成后厨听得懂的单子。

**最终交付物**：一个文件夹（规范的 npm 包），里面 6 个文件。平台方拿到后，在 DSH 桌面的"添加插件"界面里选这个文件夹，装完立即生效——不需要重启、不需要重新安装任何桌面软件。

---

## 1. 开始前的四个背景知识

### 1.1 什么是"工具"（tool）

AI 助手本身不会上网、不会调接口。它只会做一件事：**从一张"工具清单"里挑一个名字，填好参数，交给平台执行**。每个工具清单条目包含：

- **名字**：如 `dsh_expense_list`（命名规范见 §6.4）
- **说明**：告诉 AI 这个工具干什么、什么时候用（AI 靠这段话决定用不用这个工具，所以要写清楚）
- **参数表**：每个参数的名字、类型、是否必填（AI 填错参数会在进你的代码之前就被拦截）
- **执行函数**：真正干活的代码——你在这里发 HTTP 请求

### 1.2 什么是 JSON

一种"键值对"文本格式，人和程序都好读：

```json
{ "title": "出差报销", "amount": "830.00", "items": ["高铁票", "酒店发票"] }
```

你的工具包和业务系统之间传的数据基本全是 JSON。

### 1.3 什么是 Bearer 令牌（工牌）

员工登录 DSH 桌面后，平台会发一张"身份令牌"（一串很长的字符，术语叫 JWT）。**你的工具包每次调业务系统接口时，要在请求头里带上它**：

```
authorization: Bearer eyJhbGciOi...(很长一串)
```

业务系统靠它知道"这次操作是哪个员工发起的"。好消息：**平台会自动把令牌交给你的代码，你不需要管登录、不需要管令牌怎么来的**，只要照 §6.3 的模板原样放进请求头。

### 1.4 什么是 npm 包、什么是 bundle

- **npm 包**：一个含 `package.json` 的文件夹，是 JavaScript 世界标准的代码分发单位
- **bundle**：DSH 平台对"可安装插件包"的称呼。一个 bundle 就是一个普通 npm 包，只是在 `package.json` 里**多声明了一行元数据**（告诉平台"装我的时候，按我自带的补丁文件把我挂载进系统"，见 §7），再附一个补丁文件

所以"把 API.md 包装成 bundle" = 建一个 npm 包 + 写一个插件源文件 + 写一个补丁文件 + 构建成单文件。全程不碰平台的任何代码。

---

## 2. 环境准备

### 2.1 装软件

| 软件 | 版本要求 | 检查命令 |
| --- | --- | --- |
| Node.js | ≥ 22 | `node --version` |
| npm（随 Node 附带） | — | `npm --version` |

Windows 上推荐用 [nvm-windows](https://github.com/coreybutler/nvm-windows) 管理版本。编辑器推荐 VS Code。

### 2.2 找平台方确认三件事（开工前一次问清）

1. **构建依赖包的下载地址**（私有 npm registry 的地址和访问方式）。本教程需要两个平台方发布的依赖包：`@deepseek-ai/dsh-tools` 和 `@deepseek-ai/schemastery`
2. **目标 DSH 平台的版本号**（例如 `0.2.0-rc.1`）——写进包的版本声明里（§5.2）
3. **一个可以装插件的 DSH 桌面测试环境**（最后验证用）

### 2.3 你手上应该有的输入

- 业务系统的 `API.md`（接口文档：每个接口的地址、方法、请求/响应字段、错误码）
- 业务系统的一个可访问地址（如 `http://192.168.1.100:8091`），用来联调

---

## 3. 第一步：读懂 API.md，列出端点清单

把 `API.md` 从头到尾读一遍，抄成一张**端点清单表**。下面以一个报销系统（本文的贯穿示例）为例——它的 API.md 列了 13 个端点：

| # | 端点 | 方法 | 干什么 |
| --- | --- | --- | --- |
| 1 | /api/health | GET | 健康检查 |
| 2 | /api/ui-config | GET | 前端配置 |
| 3 | /api/me | GET | 当前用户 |
| 4 | /api/expenses | POST | 创建报销单 |
| 5 | /api/expenses/attachments | POST | 上传附件 |
| 6 | /api/expenses | GET | 报销单列表 |
| 7 | /api/expenses/{id} | GET | 报销单详情 |
| 8 | /api/expenses/{id}/attachments/{aid} | GET | 下载附件 |
| 9 | /api/expenses/{id}/status | PUT | 状态迁移 |
| 10 | /api/expenses/{id}/approval-records | POST | 写审批记录 |
| 11 | /api/expenses/{id}/payment | POST | 打款 |
| 12 | /api/expenses/{id}/cancel | POST | 撤回 |
| 13 | /api/expenses/{id}/process-instance | PUT | 流程实例回写 |

同时记下三样东西（写代码时要用）：

- **统一响应格式**：示例系统是"信封式"——成功 `{ "code": 0, "data": {...} }`，失败 `{ "code": 1409, "message": "..." }`。你的系统是什么格式，从 API.md 的"响应示例"里找
- **字段约束**：如"金额必须是字符串、最多两位小数"、"日期格式 yyyy-MM-dd"
- **错误码表**：如 1409 = 状态不允许。后面要翻译成人话

---

## 4. 第二步：能力裁剪——决定哪些端点给 AI

**不是所有接口都该给 AI。** 给 AI = 员工动嘴 AI 就能执行，所以必须保守。逐个端点过一遍这张判断表：

| 判断 | 结论 |
| --- | --- |
| 只读查询（列表/详情） | ✅ 一般可以给 |
| 员工本人的日常操作（建单、撤自己的单、传附件） | ✅ 一般可以给 |
| 系统管理类（健康检查、前端配置、当前用户） | ❌ 不给——平台/诊断用途，AI 用不上 |
| 二进制流（文件下载） | ❌ V1 不给——AI 没法消费文件流 |
| **改变业务状态且不该由 AI 发起的**（打款、写审批记录、状态强迁、对接其他系统的回写） | ❌ **坚决不给**——这类操作通常有专门的自动化通道（如流程引擎），审计要求"操作必须来自那个通道"；AI 碰了会破坏审计链 |

对示例系统，裁剪结论是 13 个端点只暴露 5 个：

| 工具名 | 端点 | 给 AI | 理由 |
| --- | --- | --- | --- |
| `dsh_expense_create` | 4 POST /api/expenses | ✅ | 员工本人建单 |
| `dsh_expense_list` | 6 GET /api/expenses | ✅ | 查自己的单 |
| `dsh_expense_get` | 7 GET /api/expenses/{id} | ✅ | 读单核对 |
| `dsh_expense_cancel` | 12 POST /{id}/cancel | ✅ | 系统已限制仅本人可撤 |
| `dsh_expense_upload_attachment` | 5 POST /api/expenses/attachments | ✅ | 传发票 |
| 1/2/3/8/9/10/11/13 | 其余 8 个 | ❌ | 见上表理由 |

> ⚠️ **这张表必须拿给业务方（你的雇主）确认签字后才动手写代码**。裁剪是业务决策不是技术决策——你按技术直觉多给了一个，出了事算交付事故。

---

## 5. 第三步：创建包

### 5.1 目录结构

建一个文件夹，最终长这样（先只建 `package.json` 和 `src/`，其余的后面几步会生成）：

```
my-sor-tools/
├── package.json        # 包的身份证（§5.2）
├── cordis.patch.yml    # 安装挂载说明（§7）
├── build.mjs           # 构建脚本（§8）
├── src/
│   └── index.ts        # 插件源码（§6，工作量主体）
├── lib/
│   └── index.js        # 构建产物（§8 自动生成）
└── README.md           # 你自己的交付说明（§9.3）
```

### 5.2 package.json（逐字段讲解）

```json
{
  "name": "@your-company/my-sor-tools",
  "description": "为 XX 系统提供员工端 AI 工具（工具化范围见 README 能力裁剪表）",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js" },
  "files": ["lib/index.js", "cordis.patch.yml"],
  "license": "UNLICENSED",
  "engines": {
    "dsh": ">=0.2.0-rc.1"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

| 字段 | 含义 | 注意 |
| --- | --- | --- |
| `name` | 包名。`@your-company/` 前缀叫 scope，表示你公司的命名空间，**用你雇主的真名** | 和 §7 补丁文件里的 `name` 必须一字不差 |
| `type: "module"` | 用新式 ES 模块格式 | 照抄 |
| `main` / `exports` | 指向构建产物 | 照抄 |
| `files` | 发布时打包哪些文件 | `lib/index.js` 和补丁 yml **缺一不可** |
| `engines.dsh` | **版本门禁**：声明你的包兼容哪些 DSH 版本（填 §2.2 问到的版本号） | 平台安装时会检查，不匹配直接拦下，避免装进去运行时才炸 |
| `dsh.bundle.patch` | **bundle 身份声明**：指向你包里的补丁文件 | 没有这行，平台不认为你是可安装插件 |

**注意没有 `dependencies`**——依赖会在构建时全部打进产物（§8），运行时零依赖，这是刻意设计（部署更简单）。

---

## 6. 第四步：写插件源码（src/index.ts，工作量主体）

这一步是照模板改。先把 §6.6 的完整骨架复制进去，再按 §6.1~§6.5 理解每一段在干什么，然后把"报销系统"的部分替换成你的系统。

### 6.1 插件的三个导出：name、inject、apply

平台加载你的包时，找三个导出：

```ts
// ① 插件名（日志里显示的 id）
export const name = 'my-sor-tools'

// ② 声明依赖的平台能力：等"当前用户"和"工具注册表"就绪后再挂载
//    这两行照抄——几乎所有 SOR 工具包都是这两个
export const inject = ['currentUser', 'tools'] as const

// ③ 主函数：平台启动你的插件时调用。所有工具在这里注册
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(/* 每个工具一次 defineTool(...) */)
}
```

### 6.2 Config：让 SOR 地址可配置

```ts
export const Config = z.object({
  // 默认值 = 你开发时确定的业务系统地址（一般所有机器都一样）
  // .volatile() = 允许运行时改值，改完立即生效不用重启
  sorBaseUrl: z.string().default('http://192.168.1.100:8091').volatile(),
})
```

用的时候 `config.sorBaseUrl.get()` 拿**当前值**。个别机器地址不同的解决办法见 §9.2，你不用为它写任何界面。

### 6.3 统一请求函数：sorRequest（照抄，改三处）

这是整个包里最重要的函数——所有工具共用它调 HTTP。它做四件事：带工牌、发请求、解信封、**把错误翻译成人话**（翻译质量决定 AI 能不能把错误原因准确告诉员工）。

```ts
async function sorRequest<T>(options, path, init?): Promise<T> {
  // ① 平台交给你的员工令牌；没登录就明确报错（AI 会转述"请先登录"）
  const token = options.token()
  if (token === undefined) throw new Error('未登录，无法访问 XX 系统')

  // ② 每次调用读当前配置值（volatile 的好处）
  const base = options.sorBaseUrl().replace(/\/+$/, '')

  // ③ 发请求：Bearer 工牌 + 可选 JSON 请求体
  const resp = await fetch(new URL(path, base), { method: ..., headers: { authorization: `Bearer ${token}`, ... }, body })

  // ④ 解"信封"并翻译错误 —— ★按你系统的真实格式改这三段★
  //    信封格式、业务错误码、人话文案，全部来自 API.md
  const envelope = await resp.json()
  if (!resp.ok || envelope.code !== 0) {
    throw new Error(`XX 系统返回错误（HTTP ${resp.status}，code ${envelope.code}）：${envelope.message}。请稍后再试。`)
  }
  return envelope.data
}
```

**错误翻译的三条军规**：

1. **说人话**：`"费控系统不可达(http://x)：ECONNREFUSED。请确认费控系统已启动，稍后再试。"` ✅；`"Error: connect ECONNREFUSED 127.0.0.1:8091"` ❌（AI 只能原样转述天书）
2. **给建议**：错误消息末尾告诉 AI"该说什么"（稍后再试/先上传附件/单据状态不允许撤回）
3. **带上下文**：HTTP 状态码、业务错误码、系统地址都带上，方便排查

### 6.4 注册工具：defineTool 的六个字段

每个工具一次 `ctx.tools.register(defineTool({ ... }))`，六个字段：

```ts
ctx.tools.register(defineTool({
  // ① 名字：规范 dsh_<系统名>_<动作>，全小写下划线
  name: 'dsh_expense_list',

  // ② 说明：写给 AI 看的广告词。说清三件事：干什么/什么时候用/有什么约束。
  //    AI 全靠它决定用不用这个工具，值得花时间写好
  description: '按状态过滤查询报销单列表（分页，按创建时间倒序）。用于"我的报销单""最近提交的单子"类问题。',

  // ③ 参数表：AI 能填什么。required: true 的参数 AI 必须填
  parameters: {
    status: { type: 'string', description: '按状态过滤：opened/ongoing/approved/rejected/paid/cancelled' },
    limit:  { type: 'number', description: '条数，默认 50，上限 200' },
  },

  // ④ 输出：结构化 schema + 给人看的文本渲染
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { /* ... */ } },
    render: (_args, value) => [{ type: 'text', text: `查到 ${value.expenses.length} 张报销单。` }],
  },

  // ⑤ 执行：真正的活。先做参数校验，再调 sorRequest
  async execute(args) {
    const list = await sorRequest(options, '/api/expenses?limit=50')
    return { expenses: list.map(e => ({ id: e.id, title: e.title, status: e.status })) }
  },

  // ⑥ 界面卡片：员工在屏幕上看到的"AI 正在调用 XX"卡片
  presentCall: () => ({ card: 'generic', title: '查报销单列表', kind: 'read' }),
}))
```

**三个最容易踩的坑**（都是真实踩过的）：

| 坑 | 症状 | 正确做法 |
| --- | --- | --- |
| 嵌套 object 少了 `additionalProperties: false` | 构建通过，运行时报 `UNSUPPORTED_SCHEMA` | **每个** `type: 'object'`（包括数组 items 里的）都显式写上 |
| description 写得太省 | AI 该用工具时不用、乱填参数 | 按"干什么 + 什么时候用 + 约束"三段写，把 API.md 的字段约束抄进去（如"金额正数字符串最多两位小数，如 \"830.00\""） |
| 错误直接抛原始异常 | 员工看到英文天书 | 所有错误经 §6.3 的翻译再抛 |

**参数校验放在 execute 开头做**：schema 只能查类型，查不了格式。像"金额两位小数"这种约束在 execute 里用正则拦，报错信息写清楚正确格式——AI 收到后会自动纠正重试。

### 6.5 两个典型工具的完整写法

**GET 查询型**（列表）——参数拼 query string：

```ts
async execute(args) {
  const query = new URLSearchParams()
  if (args.status !== undefined) query.set('status', args.status)
  const suffix = query.toString() === '' ? '' : `?${query.toString()}`
  const list = await sorRequest<SummaryDto[]>(options, `/api/expenses${suffix}`)
  return { expenses: list.map(e => ({ id: e.id, title: e.title, status: e.status })) }
}
```

**POST 动作型**（创建）——传 JSON 体，路径参数要 `encodeURIComponent`：

```ts
async execute(args) {
  assertAmount(args.amount)   // execute 开头做格式校验
  const detail = await sorRequest<DetailDto>(options, '/api/expenses', {
    method: 'POST',
    jsonBody: { title: args.title, amount: args.amount },
  })
  return { id: detail.id, status: detail.status }
}
```

**文件上传型**（multipart）——读本地文件塞进 FormData：

```ts
async execute(args) {
  const { readFile } = await import('node:fs/promises')
  const buffer = await readFile(args.filePath)
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buffer)]), 'invoice.png')
  const meta = await sorRequest<MetaDto>(options, '/api/expenses/attachments', { method: 'POST', body: form })
  return { attachmentId: meta.id }
}
```

### 6.6 完整骨架（从这里开始改）

下面是可直接构建的最小骨架（1 个 GET 工具 + 1 个 POST 工具）。完整 5 工具的参考实现见交付给你的示例包 `expense-sor-tools/src/index.ts`，覆盖了列表分页、详情嵌套渲染、撤回、multipart 上传等全部形态。

```ts
/**
 * XX 系统 SOR 工具包。
 * 身份令牌由平台注入（ctx.currentUser.getToken()），只在 execute 内部使用，AI 不可见。
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'my-sor-tools'
export const inject = ['currentUser', 'tools'] as const

export interface Config {
  sorBaseUrl: Volatile<string>
}
export const Config = z.object({
  sorBaseUrl: z.string().default('http://192.168.1.100:8091').volatile(),
})

interface Options {
  readonly sorBaseUrl: () => string
  readonly token: () => string | undefined
}

/** 信封：按你系统 API.md 的真实响应格式改 */
interface Envelope<T> {
  code?: number
  data?: T
  message?: string
}

async function sorRequest<T>(options: Options, path: string, init?: RequestInit & { jsonBody?: unknown }): Promise<T> {
  const token = options.token()
  if (token === undefined) throw new Error('未登录，无法访问 XX 系统')
  const base = options.sorBaseUrl().replace(/\/+$/, '')
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  let body: BodyInit | null = null
  if (init?.jsonBody !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(init.jsonBody)
  } else if (init?.body !== undefined) {
    body = init.body
  }
  let resp: Response
  try {
    resp = await fetch(new URL(path, base), { method: init?.method ?? 'GET', headers, body })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`XX 系统不可达(${base})：${message}。请确认系统已启动，稍后再试。`)
  }
  let envelope: Envelope<T>
  try {
    envelope = await resp.json() as Envelope<T>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`XX 系统响应不是 JSON（HTTP ${resp.status}）：${message}`)
  }
  if (!resp.ok || envelope.code !== 0 || envelope.data === undefined) {
    throw new Error(`XX 系统返回错误（HTTP ${resp.status}，code ${envelope.code ?? '-'}）：${envelope.message ?? '未知错误'}`)
  }
  return envelope.data
}

export function apply(ctx: Context, config: Config): void {
  const options: Options = {
    sorBaseUrl: () => config.sorBaseUrl.get(),
    token: () => ctx.currentUser.getToken(),
  }

  // ── 工具 1：查询列表（GET）────────────────────────────
  ctx.tools.register(defineTool({
    name: 'dsh_mytool_list',
    description: '查询 XX 系统的单据列表。用于"我的单子""最近提交的"类问题。',
    parameters: {
      status: { type: 'string', description: '按状态过滤（可选）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          records: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,   // ← 嵌套 object 必须有！
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.records.length === 0 ? '没有符合条件的单据。' : `单据 ${value.records.length} 条：\n${value.records.map(r => `- ${r.title}（${r.id}）`).join('\n')}`,
      }],
    },
    async execute(args) {
      const query = args.status !== undefined ? `?status=${encodeURIComponent(args.status)}` : ''
      const list = await sorRequest<Array<{ id: string; title: string }>>(options, `/api/records${query}`)
      return { records: list.map(r => ({ id: r.id, title: r.title })) }
    },
    presentCall: () => ({ card: 'generic', title: '查询单据列表', kind: 'read' }),
  }))

  // ── 工具 2：创建单据（POST）───────────────────────────
  ctx.tools.register(defineTool({
    name: 'dsh_mytool_create',
    description: '为当前登录员工在 XX 系统创建单据。创建成功返回单号。',
    parameters: {
      title: { type: 'string', required: true, description: '单据标题' },
      amount: { type: 'string', required: true, description: '金额，正数字符串最多两位小数，如 "830.00"' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `单据已创建：${value.id}（状态 ${value.status}）。` }],
    },
    async execute(args) {
      if (!/^\d+(\.\d{1,2})?$/.test(args.amount)) {
        throw new Error(`金额格式非法："${args.amount}"。要求正数字符串、最多两位小数，例如 "830.00"。`)
      }
      const detail = await sorRequest<{ id: string; status: string }>(options, '/api/records', {
        method: 'POST',
        jsonBody: { title: args.title, amount: args.amount },
      })
      return { id: detail.id, status: detail.status }
    },
    presentCall: args => ({ card: 'generic', title: '创建单据', kind: 'fetch', rawInput: args.title }),
  }))
}
```

> 工具名前缀 `dsh_mytool_` 里的 `mytool` 换成你的系统名（如 `dsh_expense_`、`dsh_crm_`）。**禁止**注册 §4 裁剪表里判 ❌ 的端点。

---

## 7. 第五步：写补丁文件 cordis.patch.yml

这个文件告诉平台"把我挂到哪"。在包根目录建 `cordis.patch.yml`，内容固定就是这个形状（改两处名字）：

```yaml
# my-sor-tools 自带补丁：随包安装/卸载。
# sorBaseUrl 在此显式声明；个别机器地址不同由平台方在机器本地覆盖，不改本文件。
- insert:
    - id: my-sor-tools
      name: "@your-company/my-sor-tools"
      config:
        sorBaseUrl: http://192.168.1.100:8091
```

逐行解释：

| 行 | 含义 |
| --- | --- |
| `- insert:` | 固定写法。表示"往系统里**插入**一个新组件"（不能漏，漏了会被当成"修改已有组件"而报警告 `entry not found`） |
| `- id: my-sor-tools` | 组件 id，等于 §6.1 代码里的 `export const name` |
| `name: "@your-company/my-sor-tools"` | npm 包名，**必须和 package.json 的 name 一字不差** |
| `config.sorBaseUrl` | 插件的默认配置，和 §6.2 的 Config 对应 |

---

## 8. 第六步：构建与自检

### 8.1 安装构建依赖

```powershell
cd my-sor-tools
# registry 地址向平台方要（§2.2），先配置 npm 使用它：
npm config set @deepseek-ai:registry <平台方给的 registry 地址>
npm i -D esbuild @deepseek-ai/dsh-tools @deepseek-ai/schemastery
```

### 8.2 构建脚本 build.mjs

在包根目录建 `build.mjs`（照抄即可，作用：把 `src/index.ts` 和两个依赖包打成**一个** `lib/index.js`）：

```js
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { build } from 'esbuild'

await mkdir(fileURLToPath(new URL('./lib', import.meta.url)), { recursive: true })

const result = await build({
  entryPoints: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./lib/index.js', import.meta.url)),
  bundle: true,          // 把 import 的依赖全部内联进单文件
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: [],          // 运行时零外部依赖（cordis 只有类型导入，自动消失）
})

if (result.warnings.length > 0) for (const w of result.warnings) console.warn('warning:', w.text)
console.log('built lib/index.js')
```

然后在 `package.json` 的 `scripts` 里加一行构建命令：

```json
"scripts": { "build": "node build.mjs" }
```

### 8.3 构建并自检

```powershell
npm run build        # 期望输出：built lib/index.js

# 冒烟测试：不连任何系统，验证包能加载、工具能注册、参数能拦
node -e "import('./lib/index.js').then(m => { const t=[]; m.apply({tools:{register:x=>t.push(x)},currentUser:{getToken:()=>'x'}},{sorBaseUrl:{get:()=>'http://x'}}); console.log(t.map(x=>x.name)) })"
```

期望输出：列出你注册的所有工具名。**报错说明代码有问题，装之前必须修好**——最常见的是 `UNSUPPORTED_SCHEMA`（回到 §6.4 的坑表查 `additionalProperties: false`）。

---

## 9. 第七步：交付、安装、验证

### 9.1 交付什么

把**整个包文件夹**（含 `lib/index.js` 构建产物）交给平台方。交付物清单：

- [ ] 包文件夹（`package.json` / `cordis.patch.yml` / `lib/index.js` / `src/` / 你自己的 `README.md`）
- [ ] 能力裁剪表（§4，有业务方确认记录）
- [ ] 自检通过的截图或输出（§8.3）

发布到私有 registry（`npm publish`）不是必须的——本地目录安装也支持；但正式环境建议发布，便于版本管理。

### 9.2 平台方怎么装（写进你的 README，替对方省事）

- **图形界面**：DSH 桌面设置 → 插件管理 → "添加插件" → 本地目录 → 选包文件夹。装完**热生效**，无需重启
- **命令行**：`dsh plugin add <包文件夹路径> --profile <平台方指定的 profile 名>`
- 个别机器 SOR 地址不同：平台方在那台机器的 profile 配置里加一条覆盖行（你只需要在交付说明里写明"本包默认地址是 xxx，覆盖方法见平台方文档"）

### 9.3 端到端验证（你的责任，交付前做一遍）

在测试环境装好后：

1. 登录 DSH 桌面
2. 对 AI 说你工具支持的话，如："帮我查一下我最近的报销单"
3. 期望：AI 发起一次工具调用（屏幕出现"查报销单列表"卡片），然后用自然语言汇报结果
4. 故意试一个错误场景（如业务系统没启动），确认 AI 能把你的错误翻译转述成人话

### 9.4 常见故障对照表

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| 安装时提示版本不兼容 | `engines.dsh` 范围和平台版本对不上 | 问平台方实际版本，更新 `engines.dsh` 重新构建 |
| 日志出现 `entry "xxx" not found` | 补丁文件漏了 `- insert:` 键 | 对照 §7 检查 yml 结构 |
| 装载报 `UNSUPPORTED_SCHEMA` | 嵌套 object 少 `additionalProperties: false` | §6.4 坑表 |
| AI 说"未登录" | 员工没登录 DSH 就发起对话 | 先登录再试 |
| 工具报"XX 系统不可达 ECONNREFUSED" | 业务系统没启动/地址错/网络不通 | 确认 SOR 地址和防火墙 |
| AI 调了工具但参数总错 | description 写得太含糊 | 按 §6.4 三段式重写，把字段约束抄进去 |
| 改了包里代码没生效 | 改的是 `src/` 没重新构建 | `npm run build` 后重装/升级；**升级已安装的包需要重启 DSH**（平台限制） |

---

## 10. 交付前检查清单

- [ ] `package.json`：name/description/version/engines.dsh/dsh.bundle.patch 齐全，`files` 含 `lib/index.js` 和 `cordis.patch.yml`
- [ ] 补丁 yml：`- insert:` 结构正确，`name` 与包名一字不差，config 默认地址正确
- [ ] 代码：`name`/`inject`/`apply` 三个导出齐全；每个 object schema 都有 `additionalProperties: false`
- [ ] 工具名全部符合 `dsh_<系统>_<动作>`；裁剪表判 ❌ 的端点一个都没注册
- [ ] 所有错误消息是人话 + 带建议（§6.3 三条军规）
- [ ] `npm run build` 无警告；§8.3 冒烟测试通过
- [ ] 测试环境端到端验证通过（§9.3，含一个错误场景）
- [ ] 能力裁剪表有业务方确认记录

## 附录：术语速查

| 术语 | 大白话 |
| --- | --- |
| SOR | 你要对接的那个业务系统（Record System，记录系统）的统称 |
| 工具（tool） | AI 能调用的一个具名能力，有名字、参数表、执行函数 |
| bundle | DSH 平台的"可安装插件包"，一个特殊的 npm 包 |
| profile | DSH 的"装载清单"，装了哪些插件由它决定（平台方管理，你不用碰） |
| JWT / Bearer | 员工登录后的身份令牌；放请求头 `authorization: Bearer xxx` |
| 信封（envelope） | 业务系统统一响应格式：`{ code, message, data }` |
| volatile | 配置的"运行时可变"标记：改值即时生效，不用重启 |
| 热安装 | 装完即生效，无需重启桌面 |
| esbuild | 把多个 JS/TS 文件打成一个文件的工具 |
