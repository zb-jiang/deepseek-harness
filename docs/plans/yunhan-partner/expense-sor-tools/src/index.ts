/**
 * Acme SI 实施交付 — 费控 SOR（expense-sor）员工端 AI 工具包。
 *
 * 参照 @deepseek-ai/dsh-process-start 的成熟模式：在员工端本地 webserver
 * 进程内注册模型侧命名工具，服务端直连 SOR REST，附当前登录员工的 JWT
 * （`ctx.currentUser.getToken()`）——token 只在 execute 内部注入，模型全程不可见。
 *
 * 能力裁剪（ sor_registry 评审结论，2026-09-30 ）：
 *   暴露给 AI：建单 / 列表 / 详情 / 撤回 / 上传附件（5 个，均为员工本人操作）。
 *   不暴露：状态迁移 / 审批记录 / 打款 / 流程实例回写（SOR API 端点 9/10/11/13）
 *   ——审计链只能来自流程引擎 delegate 的服务密钥通道，AI 不得触碰。
 *
 * @module @acme-si/expense-sor-tools
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-identity-context'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'expense-sor-tools'

/** 等待登录身份存储与工具注册表就绪后才挂载。 */
export const inject = ['currentUser', 'tools'] as const

/** 插件配置；缺省时用 schema 默认值（bundle 化后通常零配置即用）。 */
export interface Config {
  /** 费控 SOR 基地址（协议+主机+端口，无路径）；volatile：运行时改值即时生效。 */
  sorBaseUrl: Volatile<string>
}

export const Config = z.object({
  // 默认值 = 开发 bundle 时已确定的 SOR 地址；个别机器不同时，
  // 用 profile 用户补丁层的定点覆盖行改（见 README §5），或后续发新版本换默认值。
  sorBaseUrl: z.string().default('http://127.0.0.1:8091').volatile(),
})

/** 已解析的运行选项（apply 阶段完成装配）。 */
interface ExpenseSorOptions {
  /** 当前 SOR 基地址（无尾斜杠；每次调用读取 volatile 最新值）。 */
  readonly sorBaseUrl: () => string
  /** 当前登录员工的 JWT；未登录为 undefined。 */
  readonly token: () => string | undefined
}

/** SOR 统一信封：成功 `{ code: 0, data }`；失败裸信封 `{ code, message, details? }`。 */
interface SorEnvelope<T> {
  code?: number
  data?: T
  message?: string
  details?: Record<string, unknown>
}

/** 翻译成模型可转述的中文状态名。 */
const STATUS_ZH: Record<string, string> = {
  opened: '已提交',
  ongoing: '审批中',
  approved: '已批准待打款',
  rejected: '已拒绝',
  paid: '已打款',
  cancelled: '已撤回',
}

function statusZh(status: string): string {
  return STATUS_ZH[status] ?? status
}

/** 金额格式校验（正数十进制、最多两位小数），失败时给出面向模型的明确错误。 */
function assertAmount(amount: string): void {
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
    throw new Error(`金额格式非法："${amount}"。要求正数十进制字符串、最多两位小数，例如 "830.00"。`)
  }
}

/** 日期格式校验（yyyy-MM-dd）。 */
function assertDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`日期格式非法："${date}"。要求 yyyy-MM-dd，例如 "2026-09-10"。`)
  }
}

/**
 * 调 SOR REST 并解统一信封。
 *
 * @param options - 运行选项
 * @param path - 以 / 开头的绝对路径（不含 base）
 * @param init - POST 请求体（JSON）或预构好的 RequestInit（multipart）
 * @returns 信封 data
 * @throws Error 未登录 / 网络不可达 / 响应非 JSON / 业务错误码（消息面向模型呈现）
 */
async function sorRequest<T>(
  options: ExpenseSorOptions,
  path: string,
  init?: RequestInit & { jsonBody?: unknown },
): Promise<T> {
  const token = options.token()
  if (token === undefined) {
    throw new Error('未登录，无法访问费控系统')
  }
  // volatile 配置：每次调用读取当前值，设置面板修改后无需重载即生效
  const sorBaseUrl = options.sorBaseUrl().replace(/\/+$/, '')
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
    resp = await fetch(new URL(path, sorBaseUrl), {
      method: init?.method ?? 'GET',
      headers,
      body,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`费控系统不可达(${sorBaseUrl})：${message}。请确认费控系统已启动，稍后再试。`)
  }
  let envelope: SorEnvelope<T>
  try {
    envelope = await resp.json() as SorEnvelope<T>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`费控系统响应不是 JSON（HTTP ${resp.status}）：${message}`)
  }
  if (!resp.ok || envelope.code !== 0 || envelope.data === undefined) {
    const details = envelope.details === undefined ? '' : ` ${JSON.stringify(envelope.details)}`
    throw new Error(`费控系统返回错误（HTTP ${resp.status}，code ${envelope.code ?? '-'}）：${envelope.message ?? '未知错误'}${details}`)
  }
  return envelope.data
}

/** SOR 明细行（请求侧最小集）。 */
interface ExpenseItemInput {
  category: string
  amount: string
  occurredDate: string
  description: string
}

export function apply(ctx: Context, config: Config): void {
  const options: ExpenseSorOptions = {
    sorBaseUrl: () => config.sorBaseUrl.get(),
    token: () => ctx.currentUser.getToken(),
  }

  // ── 1. 创建报销单（POST /api/expenses）─────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'dsh_expense_create',
    description: '为当前登录员工在费控系统创建报销单（创建即 opened/已提交状态）。totalAmount 由服务端按明细自动求和，调用方不传。创建成功后返回报销单号 expenseId。',
    parameters: {
      title: { type: 'string', required: true, description: '单据标题（简短）' },
      reason: { type: 'string', required: true, description: '报销事由' },
      submitterName: { type: 'string', required: true, description: '提交人姓名，取自身份块当前用户姓名' },
      items: {
        type: 'array',
        required: true,
        description: '明细行，至少 1 条',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            category: { type: 'string', required: true, description: '费用类别：交通/住宿/餐饮/办公/其他' },
            amount: { type: 'string', required: true, description: '金额，正数字符串最多两位小数，如 "830.00"' },
            occurredDate: { type: 'string', required: true, description: '发生日期 yyyy-MM-dd' },
            description: { type: 'string', required: true, description: '说明' },
          },
        },
      },
      attachmentIds: { type: 'array', items: { type: 'string' }, description: '先经 dsh_expense_upload_attachment 上传得到的附件 id 列表' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          expenseId: { type: 'string', required: true },
          totalAmount: { type: 'string', required: true },
          status: { type: 'string', required: true },
          statusZh: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `报销单已创建：单号 ${value.expenseId}，合计 ${value.totalAmount} 元（${statusZh(value.status)}）。`,
      }],
    },
    async execute(args) {
      for (const item of args.items) {
        assertAmount(item.amount)
        assertDate(item.occurredDate)
      }
      const detail = await sorRequest<ExpenseDetailDto>(options, '/api/expenses', {
        method: 'POST',
        jsonBody: {
          title: args.title,
          reason: args.reason,
          submitterName: args.submitterName,
          items: args.items,
          ...(args.attachmentIds !== undefined && args.attachmentIds.length > 0 ? { attachmentIds: args.attachmentIds } : {}),
        },
      })
      return { expenseId: detail.id, totalAmount: detail.totalAmount, status: detail.status, statusZh: statusZh(detail.status) }
    },
    presentCall: args => ({ card: 'generic', title: '创建报销单', kind: 'fetch', rawInput: args.title }),
  }))

  // ── 2. 报销单列表（GET /api/expenses）──────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'dsh_expense_list',
    description: '查询当前登录员工自己提交的报销单列表（仅本人创建的单据，服务端按登录身份过滤；分页，按创建时间倒序）。用于"我的报销单""最近提交的单子"类问题。待本人审批的单据走流程待办，不在本列表范围。',
    parameters: {
      status: { type: 'string', description: '按状态过滤：opened/ongoing/approved/rejected/paid/cancelled' },
      offset: { type: 'number', description: '偏移量，默认 0' },
      limit: { type: 'number', description: '条数，默认 50，上限 200' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          expenses: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                totalAmount: { type: 'string', required: true },
                status: { type: 'string', required: true },
                statusZh: { type: 'string', required: true },
                submitterName: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.expenses.length === 0
          ? '没有符合条件的报销单。'
          : `报销单 ${value.expenses.length} 张：\n${value.expenses.map(e => `- ${e.title}（单号 ${e.id}，${e.totalAmount} 元，${statusZh(e.status)}）`).join('\n')}`,
      }],
    },
    async execute(args) {
      const query = new URLSearchParams()
      if (args.status !== undefined) query.set('status', args.status)
      if (args.offset !== undefined) query.set('offset', String(args.offset))
      if (args.limit !== undefined) query.set('limit', String(args.limit))
      const suffix = query.toString() === '' ? '' : `?${query.toString()}`
      const list = await sorRequest<ExpenseSummaryDto[]>(options, `/api/expenses${suffix}`)
      return {
        expenses: list.map(e => ({
          id: e.id,
          title: e.title,
          totalAmount: e.totalAmount,
          status: e.status,
          statusZh: statusZh(e.status),
          submitterName: e.submitterName,
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: '查报销单列表', kind: 'read' }),
  }))

  // ── 3. 报销单详情（GET /api/expenses/{id}）────────────────────────────
  ctx.tools.register(defineTool({
    name: 'dsh_expense_get',
    description: '按报销单号读取单据完整信息：明细、附件、审批记录、打款记录。审批复核与员工查单都用它。',
    parameters: {
      expenseId: { type: 'string', required: true, description: '报销单 UUID' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          expense: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              title: { type: 'string', required: true },
              reason: { type: 'string', required: true },
              totalAmount: { type: 'string', required: true },
              currency: { type: 'string', required: true },
              status: { type: 'string', required: true },
              statusZh: { type: 'string', required: true },
              submitterName: { type: 'string', required: true },
              processInstanceId: { type: 'string' },
              items: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    category: { type: 'string', required: true },
                    amount: { type: 'string', required: true },
                    occurredDate: { type: 'string', required: true },
                    description: { type: 'string', required: true },
                  },
                },
              },
              attachments: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    fileName: { type: 'string', required: true },
                    contentType: { type: 'string', required: true },
                    sizeBytes: { type: 'number', required: true },
                  },
                },
              },
              approvalRecords: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    activityId: { type: 'string', required: true },
                    decision: { type: 'string', required: true },
                    comment: { type: 'string' },
                    approverName: { type: 'string', required: true },
                    createdAt: { type: 'string', required: true },
                  },
                },
              },
              payment: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  amount: { type: 'string', required: true },
                  channel: { type: 'string', required: true },
                  paidName: { type: 'string', required: true },
                  paidAt: { type: 'string', required: true },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderExpenseDetail(value.expense as ExpenseDetailDto & { statusZh: string }),
      }],
    },
    async execute(args) {
      const detail = await sorRequest<ExpenseDetailDto>(options, `/api/expenses/${encodeURIComponent(args.expenseId)}`)
      return {
        expense: {
          id: detail.id,
          title: detail.title,
          reason: detail.reason,
          totalAmount: detail.totalAmount,
          currency: 'CNY',
          status: detail.status,
          statusZh: statusZh(detail.status),
          submitterName: detail.submitterName,
          ...(detail.processInstanceId !== null ? { processInstanceId: detail.processInstanceId } : {}),
          items: detail.items.map(i => ({
            category: i.category,
            amount: i.amount,
            occurredDate: i.occurredDate,
            description: i.description,
          })),
          attachments: detail.attachments.map(a => ({
            id: a.id,
            fileName: a.fileName,
            contentType: a.contentType,
            sizeBytes: a.sizeBytes,
          })),
          approvalRecords: detail.approvalRecords.map(r => ({
            activityId: String(r.activityId ?? ''),
            decision: String(r.decision ?? ''),
            ...(r.comment !== undefined && r.comment !== null ? { comment: String(r.comment) } : {}),
            approverName: String(r.approverName ?? ''),
            createdAt: String(r.createdAt ?? ''),
          })),
          ...(detail.payment !== null
            ? {
                payment: {
                  amount: String(detail.payment.amount ?? ''),
                  channel: String(detail.payment.channel ?? ''),
                  paidName: String(detail.payment.paidName ?? ''),
                  paidAt: String(detail.payment.paidAt ?? ''),
                },
              }
            : {}),
        },
      }
    },
    presentCall: args => ({ card: 'generic', title: '读报销单详情', kind: 'read', rawInput: args.expenseId }),
  }))

  // ── 4. 撤回报销单（POST /api/expenses/{id}/cancel）────────────────────
  ctx.tools.register(defineTool({
    name: 'dsh_expense_cancel',
    description: '撤回当前登录员工自己的一张报销单。仅 ongoing（审批中）/ approved（已批准）状态可撤；仅提交人本人可撤；撤回后状态为 cancelled（终态，不可恢复）。',
    parameters: {
      expenseId: { type: 'string', required: true, description: '报销单 UUID' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          expenseId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          statusZh: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `报销单 ${value.expenseId} 已撤回（${statusZh(value.status)}）。`,
      }],
    },
    async execute(args) {
      const detail = await sorRequest<ExpenseDetailDto>(options, `/api/expenses/${encodeURIComponent(args.expenseId)}/cancel`, { method: 'POST' })
      return { expenseId: detail.id, status: detail.status, statusZh: statusZh(detail.status) }
    },
    presentCall: args => ({ card: 'generic', title: '撤回报销单', kind: 'fetch', rawInput: args.expenseId }),
  }))

  // ── 5. 上传附件（POST /api/expenses/attachments，multipart）────────────
  ctx.tools.register(defineTool({
    name: 'dsh_expense_upload_attachment',
    description: '把员工提供的发票文件上传到费控系统（先独立上传，建单时用返回的 attachmentId 关联）。仅支持 pdf/png/jpeg，单个 ≤10MB。filePath 用员工会话中附件的本地绝对路径。',
    parameters: {
      filePath: { type: 'string', required: true, description: '发票文件的本地绝对路径（来自员工上传的附件）' },
      fileName: { type: 'string', description: '展示用文件名；缺省取路径最后一段' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string', required: true },
          fileName: { type: 'string', required: true },
          sizeBytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `附件已上传：${value.fileName}（attachmentId ${value.attachmentId}，${value.sizeBytes} 字节）。`,
      }],
    },
    async execute(args) {
      const { readFile } = await import('node:fs/promises')
      const { basename } = await import('node:path')
      const buffer = await readFile(args.filePath)
      if (buffer.byteLength > 10 * 1024 * 1024) {
        throw new Error(`附件超过 10MB 上限（${buffer.byteLength} 字节）：${args.filePath}`)
      }
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(buffer)]), args.fileName ?? basename(args.filePath))
      const meta = await sorRequest<AttachmentMetaDto>(options, '/api/expenses/attachments', { method: 'POST', body: form })
      return { attachmentId: meta.id, fileName: meta.fileName, sizeBytes: meta.sizeBytes }
    },
    presentCall: args => ({ card: 'generic', title: '上传发票附件', kind: 'fetch', rawInput: args.fileName ?? args.filePath }),
  }))
}

/** SOR 详情响应（工具输出消费的最小字段集）。 */
interface ExpenseDetailDto {
  id: string
  title: string
  reason: string
  totalAmount: string
  status: string
  submitterName: string
  items: ExpenseItemInput[]
  attachments: AttachmentMetaDto[]
  approvalRecords: Array<Record<string, unknown>>
  payment: Record<string, unknown> | null
}

interface ExpenseSummaryDto {
  id: string
  title: string
  totalAmount: string
  status: string
  submitterName: string
}

interface AttachmentMetaDto {
  id: string
  fileName: string
  contentType: string
  sizeBytes: number
}

/** 详情的人话渲染（模型可见的文本 + 界面卡片同源）。 */
function renderExpenseDetail(e: ExpenseDetailDto): string {
  const lines: string[] = [
    `报销单 ${e.title}（单号 ${e.id}）`,
    `事由：${e.reason}`,
    `合计：${e.totalAmount} 元，状态：${statusZh(e.status)}`,
    `明细 ${e.items.length} 行：`,
    ...e.items.map(i => `  - ${i.category} ${i.amount} 元 ${i.occurredDate} ${i.description}`),
  ]
  if (e.attachments.length > 0) {
    lines.push(`附件 ${e.attachments.length} 个：${e.attachments.map(a => a.fileName).join('、')}`)
  }
  if (e.approvalRecords.length > 0) {
    lines.push(`审批记录 ${e.approvalRecords.length} 条（详见结构化输出）`)
  }
  if (e.payment !== null) {
    lines.push('已有打款记录（详见结构化输出）')
  }
  return lines.join('\n')
}
