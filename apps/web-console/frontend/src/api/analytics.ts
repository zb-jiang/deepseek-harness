import { get } from './client'

/**
 * 分析看板 API(设计 2026-09-25)。
 *
 * - business/*:业务分析(引擎 ACT_HI_* 聚合,web-console 代理透传用户 JWT);
 * - ops/*:运维健康(web-console 轮询落库的 dsh_metrics_sample)。
 */

export interface AnalyticsOverview {
  started: number
  completed: number
  running: number
  terminated: number
  avgDurationMs: number | null
  p95DurationMs: number | null
}

export interface DailyVolume {
  date: string
  started: number
  completed: number
}

export interface ActivityStat {
  activityId: string
  activityName: string | null
  activityType: string
  count: number
  avgDurationMs: number | null
  maxDurationMs: number | null
}

export interface TaskStat {
  assignee: string
  count: number
  avgDurationMs: number | null
  maxDurationMs: number | null
  /** web-console join platform_users 补齐;无治理记录时缺省(前端回退显示 user.id)。 */
  displayName?: string
}

export interface SeriesPoint {
  ts: string
  value: number
}

export interface OpsSummary {
  /** 各白名单指标最新 VALUE(job 积压/连接池/JVM 实时值)。 */
  latest: Record<string, number>
  backendTaskSuccessRate: number | null
  backendTaskCount1h: number | null
  backendTaskAvgLatencyMs: number | null
  escalationCount1h: number | null
}

/** backend task 成功率/时延差分数据源指标名(对齐后端 OpsSummaryDto 常量)。 */
export const BACKEND_TASK_SUCCESS = 'dsh.backend.task{outcome=success}'
export const BACKEND_TASK_FAILED = 'dsh.backend.task{outcome=failed}'

export const analyticsApi = {
  overview: (params: { days: number; processDefinitionKey?: string }) =>
    get<AnalyticsOverview>('/api/analytics/business/overview', params),
  dailyVolumes: (params: { days: number; processDefinitionKey?: string }) =>
    get<DailyVolume[]>('/api/analytics/business/daily-volumes', params),
  activityStats: (params: { days: number; processDefinitionKey?: string }) =>
    get<ActivityStat[]>('/api/analytics/business/activity-stats', params),
  taskStats: (params: { days: number; processDefinitionKey?: string }) =>
    get<TaskStat[]>('/api/analytics/business/task-stats', params),
  /** 部署版 BPMN XML(热力图渲染,按部署版本 procdefId)。 */
  bpmnXml: (processDefinitionId: string) =>
    get<string>('/api/analytics/business/bpmn-xml', { processDefinitionId }),
  opsSeries: (params: { metric: string; statistic?: string; from: string; to?: string }) =>
    get<SeriesPoint[]>('/api/analytics/ops/series', params),
  opsSummary: () => get<OpsSummary>('/api/analytics/ops/summary'),
}
