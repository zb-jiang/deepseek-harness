/**
 * 任务列表视图选项:分组(按日期/按流程类型)与排序(升序/降序)的纯派生
 * 逻辑与 localStorage 记忆。我的待办与已完成两个列表各自持有一份选项
 * (键位独立),默认按日期分组 + 降序(最新的日期组在前)。
 *
 * <p>联动规则(与工作区"视图选项"同思路,升降序同时作用于组间与组内):
 * 按日期分组时组内按标题排序、组间按日期排序;按流程类型分组时组内按
 * 时间排序(降序 = 最新在前)、组间按流程类型名排序。无法解析时间的行
 * 在时间排序中恒排组内末尾,按日期分组时归入"未知时间"组并恒排最后。
 */
import type { CompletedTask, Task } from './task-api.ts'
import { formatShortTime } from './workbench/hooks.ts'

/** 分组维度:按日期 / 按流程类型。 */
export type TaskGroupBy = 'date' | 'processType'

/** 排序方向:升序 / 降序。 */
export type TaskOrderDir = 'asc' | 'desc'

/** 一个列表的视图选项。 */
export type TaskViewOptions = {
  groupBy: TaskGroupBy
  orderBy: TaskOrderDir
}

/** 两个列表各自的视图选项(localStorage 持久化的整体形状)。 */
export type TaskViewState = {
  pending: TaskViewOptions
  completed: TaskViewOptions
}

/** 行的归一化渲染/分组面:待办与已完成映射到同一形状。 */
export type TaskViewRow = {
  /** 人读标题(任务名优先,回退任务 id)。 */
  title: string
  /** 排序用时间戳(ms);ISO 解析失败为 null。 */
  timeMs: number | null
  /** 行内右侧绝对短时间(MM-DD HH:mm);解析失败原样展示。 */
  timeLabel: string
  /** 流程类型人读名(定义名优先,回退定义 id 的 key 段)。 */
  processLabel: string
}

/** 分组结果:行携带原条目,点击行为仍需要原始任务对象。 */
export type TaskViewGroup<T> = {
  key: string
  label: string
  rows: readonly { item: T; row: TaskViewRow }[]
}

/** 默认视图:按日期分组 + 降序(最新在前)。 */
export const DEFAULT_TASK_VIEW_OPTIONS: TaskViewOptions = { groupBy: 'date', orderBy: 'desc' }

const VIEW_STATE_KEY = 'dsh-enterprise-task-view-options'

function isGroupBy(value: unknown): value is TaskGroupBy {
  return value === 'date' || value === 'processType'
}

function isOrderDir(value: unknown): value is TaskOrderDir {
  return value === 'asc' || value === 'desc'
}

/** 单列表选项的逐字段容错读取:非法值回退默认。 */
function readOptions(raw: unknown): TaskViewOptions {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_TASK_VIEW_OPTIONS }
  const record = raw as Record<string, unknown>
  return {
    groupBy: isGroupBy(record.groupBy) ? record.groupBy : DEFAULT_TASK_VIEW_OPTIONS.groupBy,
    orderBy: isOrderDir(record.orderBy) ? record.orderBy : DEFAULT_TASK_VIEW_OPTIONS.orderBy,
  }
}

function defaultViewState(): TaskViewState {
  return {
    pending: { ...DEFAULT_TASK_VIEW_OPTIONS },
    completed: { ...DEFAULT_TASK_VIEW_OPTIONS },
  }
}

/** 读取持久化的两个列表视图选项;无存储或条目损坏按默认处理。
 * @returns 两个列表各自的视图选项(逐字段容错后的结果)。
 */
export function loadTaskViewState(): TaskViewState {
  if (typeof window === 'undefined') return defaultViewState()
  try {
    const raw = window.localStorage.getItem(VIEW_STATE_KEY)
    if (raw === null) return defaultViewState()
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return defaultViewState()
    const record = parsed as Record<string, unknown>
    return { pending: readOptions(record.pending), completed: readOptions(record.completed) }
  } catch {
    // localStorage 条目损坏(JSON 解析失败):按默认视图处理,不阻断工作台。
    return defaultViewState()
  }
}

/** 写回持久化;存储不可写(私隐模式/配额)时仅内存生效。
 * @param state 要持久化的两个列表视图选项。
 */
export function saveTaskViewState(state: TaskViewState): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(state))
  } catch {
    // 写失败只损失刷新后的视图记忆,内存选项当次会话仍有效。
  }
}

/** Flowable processDefinitionId 形如 `key:version:uuid`,取首段做人读回退。 */
function processLabelFor(name: string | null, definitionId: string): string {
  if (name !== null && name !== '') return name
  const key = definitionId.split(':')[0] ?? ''
  return key !== '' ? key : '未知流程'
}

function timeFields(iso: string | null): { timeMs: number | null; timeLabel: string } {
  if (iso === null) return { timeMs: null, timeLabel: '' }
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return { timeMs: null, timeLabel: iso }
  return { timeMs: ms, timeLabel: formatShortTime(iso) }
}

/** 待办 → 视图行。
 * @param task 引擎待办任务。
 * @returns 归一化后的渲染/分组行。
 */
export function pendingTaskRow(task: Task): TaskViewRow {
  const { timeMs, timeLabel } = timeFields(task.createTime)
  return {
    title: task.name ?? task.id,
    timeMs,
    timeLabel,
    processLabel: processLabelFor(task.processDefinitionName, task.processDefinitionId),
  }
}

/** 已完成 → 视图行(历史 DTO 的定义名缺失时回退定义 id 的 key 段)。
 * @param task 引擎历史任务。
 * @returns 归一化后的渲染/分组行。
 */
export function completedTaskRow(task: CompletedTask): TaskViewRow {
  const { timeMs, timeLabel } = timeFields(task.endTime)
  return {
    title: task.name ?? task.id,
    timeMs,
    timeLabel,
    processLabel: processLabelFor(task.processDefinitionName, task.processDefinitionId),
  }
}

/** 标题字典序(中文按拼音,数字按值);组间与组内的字母排序共用。 */
function compareTitles(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true })
}

/** 本地时区日期键 = 组标题(YYYY-MM-DD;字符串字典序即时间序)。 */
function dateKeyOf(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function sortByTitle<T>(
  rows: readonly { item: T; row: TaskViewRow }[],
  orderBy: TaskOrderDir,
): typeof rows {
  return [...rows].sort((a, b) => orderBy === 'asc'
    ? compareTitles(a.row.title, b.row.title)
    : compareTitles(b.row.title, a.row.title))
}

/** 时间排序;无法解析时间的行恒排末尾(与方向无关)。 */
function sortByTime<T>(
  rows: readonly { item: T; row: TaskViewRow }[],
  orderBy: TaskOrderDir,
): typeof rows {
  return [...rows].sort((a, b) => {
    const at = a.row.timeMs
    const bt = b.row.timeMs
    if (at === null && bt === null) return 0
    if (at === null) return 1
    if (bt === null) return -1
    return orderBy === 'asc' ? at - bt : bt - at
  })
}

/**
 * 派生分组与排序后的列表(纯函数,组件侧 useMemo 缓存)。
 * @param items   原始条目(待办或已完成)。
 * @param options 当前视图选项。
 * @param project 条目 → 视图行的归一化映射。
 * @returns 组间已按联动规则排序的分组;空列表返回空数组。
 */
export function deriveTaskGroups<T>(
  items: readonly T[],
  options: TaskViewOptions,
  project: (item: T) => TaskViewRow,
): TaskViewGroup<T>[] {
  const projected = items.map(item => ({ item, row: project(item) }))
  if (options.groupBy === 'processType') {
    const buckets = new Map<string, { item: T; row: TaskViewRow }[]>()
    for (const entry of projected) {
      const bucket = buckets.get(entry.row.processLabel)
      if (bucket === undefined) buckets.set(entry.row.processLabel, [entry])
      else bucket.push(entry)
    }
    const groups = [...buckets.entries()].map(([label, rows]) => ({
      key: label,
      label,
      rows: sortByTime(rows, options.orderBy),
    }))
    return groups.sort((a, b) => options.orderBy === 'asc'
      ? compareTitles(a.label, b.label)
      : compareTitles(b.label, a.label))
  }
  const dated = new Map<string, { item: T; row: TaskViewRow }[]>()
  const undated: { item: T; row: TaskViewRow }[] = []
  for (const entry of projected) {
    if (entry.row.timeMs === null) {
      undated.push(entry)
      continue
    }
    const key = dateKeyOf(entry.row.timeMs)
    const bucket = dated.get(key)
    if (bucket === undefined) dated.set(key, [entry])
    else bucket.push(entry)
  }
  const groups = [...dated.entries()].map(([key, rows]) => ({
    key,
    label: key,
    rows: sortByTitle(rows, options.orderBy),
  }))
  groups.sort((a, b) => options.orderBy === 'asc'
    ? compareTitles(a.key, b.key)
    : compareTitles(b.key, a.key))
  if (undated.length > 0) {
    groups.push({ key: 'unknown', label: '未知时间', rows: sortByTitle(undated, options.orderBy) })
  }
  return groups
}
