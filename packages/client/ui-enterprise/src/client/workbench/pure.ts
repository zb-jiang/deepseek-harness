/**
 * 工作台纯函数层:AI 输出 JSON 提取、输出映射 → 流程变量构建、历史活动状态归并。
 *
 * <p>无 React、无副作用;组件与单测共用,是档案栏三块动态内容
 * (AI 输出 / 提交映射 / 流程进度)的唯一推导逻辑。
 */
import type { AssistantMessageNode, ConversationNode } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ContextVariable, ContextVariableField, HistoricActivity, OutputMapping,
} from '../task-api.ts'

// ── AI 输出 JSON 提取 ──

/** 助手节点的可见正文(拼合 text 块,跳过 reasoning/tool-call)。 */
function assistantText(node: AssistantMessageNode): string {
  return node.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('')
}

/**
 * 取会话中最近一个可解析的 JSON:从最后一条助手消息向前扫描,首个提取成功
 * 的 JSON 即返回。继续对话产生无 JSON 的新消息时,输出区保持显示此前最近
 * 的 JSON(历史块不因后续纯文本回复而丢失);要选更早的历史块,走档案栏
 * 下拉选块(collectJsonBlocks)。
 * @param nodes 会话节点序列(seq 升序)。
 * @returns 解析后的 JSON 值;整段会话无合法 JSON 时为 undefined。
 */
export function latestJson(nodes: readonly ConversationNode[]): unknown | undefined {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (node?.kind !== 'assistant') continue
    const parsed = extractJson(assistantText(node))
    if (parsed !== undefined) return parsed
  }
  return undefined
}

/** 会话中一个可提交的 JSON 块(每条助手消息至多一个,提取规则同 latestJson)。 */
export type JsonBlock = {
  /** 来源助手消息的回复序号(第 N 条助手回复,1 起)。 */
  messageNo: number
  /** 块内容的单行预览(超长截断),下拉选项展示用。 */
  preview: string
  /** 解析后的 JSON 值。 */
  value: unknown
}

/**
 * 按时间顺序收集会话中全部 JSON 块(档案栏下拉选块数据源)。
 * @param nodes 会话节点序列(seq 升序)。
 * @returns JSON 块列表;无 JSON 时为空数组。
 */
export function collectJsonBlocks(nodes: readonly ConversationNode[]): JsonBlock[] {
  const blocks: JsonBlock[] = []
  let messageNo = 0
  for (const node of nodes) {
    if (node?.kind !== 'assistant') continue
    messageNo++
    const value = extractJson(assistantText(node))
    if (value === undefined) continue
    blocks.push({ messageNo, preview: previewOf(value), value })
  }
  return blocks
}

/** 块值 → 单行预览(紧凑 JSON,60 字符截断)。 */
function previewOf(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/**
 * 从助手正文提取 JSON:优先取最后一个 ``` 代码围栏块,退化为首个配平的
 * `{...}` / `[...]` 片段;均解析失败返回 undefined。
 * @param text 助手正文(可能为 null/空)。
 * @returns 解析后的 JSON 值;无合法 JSON 时为 undefined。
 */
export function extractJson(text: string | null): unknown | undefined {
  if (text == null || text.trim() === '') return undefined

  // 最后一个围栏块优先:多轮输出时以最新代码块为准。
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g
  let lastFence: string | undefined
  for (const match of text.matchAll(fenced)) {
    lastFence = match[1]
  }
  if (lastFence !== undefined) {
    const parsed = tryParse(lastFence)
    if (parsed !== undefined) return parsed
  }

  const balanced = firstBalancedJson(text)
  return balanced === undefined ? undefined : tryParse(balanced)
}

function tryParse(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/** 首个配平的对象/数组片段(字符串与转义感知);无候选返回 undefined。 */
function firstBalancedJson(text: string): string | undefined {
  const start = text.search(/[{[]/)
  if (start < 0) return undefined
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

// ── 输出映射 → 流程变量 ──

/** 一条源(JSON 字段路径)→ 目标(上下文变量路径)映射。 */
export type SubmitMapping = {
  source: string
  target: string
}

/**
 * 从任务声明的输出映射生成默认映射行(空目标行丢弃)。
 * @param mappings 任务 dshMeta.outputMappings(可空)。
 * @returns 可编辑映射行初值。
 */
export function defaultMappings(mappings: readonly OutputMapping[] | null | undefined): SubmitMapping[] {
  return (mappings ?? [])
    .filter((m): m is { source: string | null; target: string } => typeof m.target === 'string' && m.target !== '')
    .map(m => ({ source: m.source ?? '', target: m.target }))
}

/**
 * 目标变量下拉选项:顶层变量 + 递归字段路径。
 * @param variables 流程上下文变量声明。
 * @returns value(点分路径)/ label(路径 (类型)) 选项表。
 */
export function targetOptions(variables: readonly ContextVariable[]): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = []
  for (const v of variables) {
    out.push({ value: v.name, label: `${v.name} (${v.type})` })
    for (const field of v.fields ?? []) collectFieldOptions(v.name, field, out)
  }
  return out
}

function collectFieldOptions(
  prefix: string,
  field: ContextVariableField,
  out: Array<{ value: string; label: string }>,
): void {
  const path = `${prefix}.${field.name}`
  out.push({ value: path, label: `${path} (${field.type})` })
  for (const f of field.fields ?? []) collectFieldOptions(path, f, out)
}

/**
 * 按映射行把 AI JSON 组装为提交变量载荷;目标根变量未声明时抛错(提交前校验)。
 * @param json 解析后的 AI 输出。
 * @param mappings 可编辑映射行。
 * @param variables 流程上下文变量声明。
 * @returns POST /complete 的 variables 载荷。
 * @throws 目标根变量不在声明表中。
 */
export function buildVariables(
  json: unknown,
  mappings: readonly SubmitMapping[],
  variables: readonly ContextVariable[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const declared = new Map(variables.map(v => [v.name, v]))
  for (const m of mappings) {
    if (m.target === '') continue
    const root = m.target.split('.')[0] ?? ''
    if (!declared.has(root)) {
      throw new Error(`变量 ${root} 未在流程上下文声明中定义`)
    }
    writePath(result, m.target, readPath(json, m.source))
  }
  return result
}

function readPath(root: unknown, path: string): unknown {
  if (path.trim() === '') return root
  let current = root
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function writePath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.')
  let current: Record<string, unknown> = root
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i] ?? ''
    let next = current[seg]
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      next = {}
      current[seg] = next
    }
    current = next as Record<string, unknown>
  }
  current[segments[segments.length - 1] ?? ''] = value
}

// ── 历史活动 → 流程进度 ──

/** 一个节点的进度状态:已完成 / 进行中。 */
export type ActivityStatus = 'done' | 'active'

/**
 * 归并历史活动为节点状态表(sequenceFlow 也入表,用于连线着色):
 * 同一 activityId 任一次未结束即为进行中,全部结束为已完成。
 * @param activities 实例的历史活动记录。
 * @returns activityId → 状态。
 */
export function activityStatuses(activities: readonly HistoricActivity[]): Map<string, ActivityStatus> {
  const statuses = new Map<string, ActivityStatus>()
  for (const activity of activities) {
    const current: ActivityStatus = activity.endTime !== null ? 'done' : 'active'
    const prev = statuses.get(activity.activityId)
    if (prev === undefined || current === 'active' || prev === 'done') {
      statuses.set(activity.activityId, current)
    }
  }
  return statuses
}

/**
 * 执行记录列表:过滤连线类活动,按开始时间排序(同毫秒保持引擎返回顺序)。
 * @param activities 实例的历史活动记录。
 * @returns 时间线展示用的活动记录。
 */
export function executionRecords(activities: readonly HistoricActivity[]): HistoricActivity[] {
  return activities
    .filter(a => a.activityType !== 'sequenceFlow')
    .map((a, index) => ({ a, index }))
    .sort((x, y) => compareTime(x.a.startTime, y.a.startTime) || x.index - y.index)
    .map(({ a }) => a)
}

function compareTime(a: string | null, b: string | null): number {
  const ta = a === null ? Number.POSITIVE_INFINITY : Date.parse(a)
  const tb = b === null ? Number.POSITIVE_INFINITY : Date.parse(b)
  return ta - tb
}
