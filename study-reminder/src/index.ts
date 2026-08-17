import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

export const name = 'study-reminder'
export const inject = ['tools', 'sessions']   // 第5章：多依赖一个 sessions 服务

// 第7章：Config 接口 + schema（不变）
export interface Reminder {
  id: number
  title: string
  due: string      // "YYYY-MM-DD HH:MM"
}
export interface Config {
  maxReminders: number
  defaultLeadMinutes: number
}
export const Config: Schema<Config> = Schema.object({
  maxReminders: Schema.number().default(50),
  defaultLeadMinutes: Schema.number().default(30),
})

// ===== 8.6 新增：事件负载 + 登记词汇 + 重放函数 =====

/** 一次提醒变动 = 一条事件。version 字段留给将来结构演进。 */
export type ReminderChange =
  | { version: 1; operation: 'create'; reminder: Reminder }
  | { version: 1; operation: 'delete'; id: number }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 一次学习提醒的变动（创建或删除）。log-only：记录在日志里，但不进模型对话历史。 */
    'reminder/change': ReminderChange
  }
}

/** 从日志重放出当前提醒清单（第2章：日记是真相，清单是投影）。 */
export function foldReminders(events: readonly SessionEvent[]): Reminder[] {
  const live = new Map<number, Reminder>()
  for (const event of events) {
    if (event.type !== 'reminder/change') continue
    const change = event.data
    if (change.operation === 'create') live.set(change.reminder.id, change.reminder)
    else live.delete(change.id)
  }
  return [...live.values()].sort((a, b) => a.id - b.id)
}

export function apply(ctx: Context, config: Config) {

  // 工具①：创建提醒（记一条 create 事件）
  ctx.tools.register(defineTool({
    name: 'reminder_create',
    description: '创建一条学习提醒。返回新提醒的 id 和内容。',
    parameters: {
      title: { type: 'string', required: true, description: '提醒内容，如"复习数学第三章"' },
      due:   { type: 'string', required: true, description: '到期时间，格式 YYYY-MM-DD HH:MM' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      const agent = exec.agent                    // 谁在调我（agent loop 填的）
      if (!agent) return 'reminder_create 只能在会话中使用'
      const session = agent.session               // 这本会话的日记
      const live = foldReminders(session.events)  // 重放出现状
      if (live.length >= config.maxReminders) {
        return `已达上限 ${config.maxReminders}，不能再加`
      }
      const id = live.reduce((max, r) => Math.max(max, r.id), 0) + 1
      const reminder: Reminder = { id, title: args.title, due: args.due }
      session.append('reminder/change', { version: 1, operation: 'create', reminder })
      await ctx.sessions.flush(session)           // 等真正落盘，再向模型确认
      return `已创建 #${reminder.id}：${reminder.title}，到期 ${reminder.due}`
    },
  }))

  // 工具②：列出提醒（纯重放，不写任何东西）
  ctx.tools.register(defineTool({
    name: 'reminder_list',
    description: '列出所有学习提醒。',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(_args, exec) {
      if (!exec.agent) return '当前没有提醒。'
      const list = foldReminders(exec.agent.session.events)
      if (list.length === 0) return '当前没有提醒。'
      return list.map(r => `#${r.id}  ${r.due}  ${r.title}`).join('\n')
    },
  }))

  // 工具③：删除提醒（记一条 delete 事件）
  ctx.tools.register(defineTool({
    name: 'reminder_delete',
    description: '按 id 删除一条学习提醒。',
    parameters: { id: { type: 'number', required: true, description: '提醒 id' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args, exec) {
      if (!exec.agent) return 'reminder_delete 只能在会话中使用'
      const session = exec.agent.session
      const live = foldReminders(session.events)
      if (!live.some(r => r.id === args.id)) return `找不到 #${args.id}`
      session.append('reminder/change', { version: 1, operation: 'delete', id: args.id })
      await ctx.sessions.flush(session)
      return `已删除 #${args.id}`
    },
  }))
}
