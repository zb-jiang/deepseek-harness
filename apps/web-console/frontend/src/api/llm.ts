import { del, get, http, post } from './client'
import type { ApiResponse } from './types'

/**
 * 类型化 PUT 包装:成功时直接返回 data 字段(T)。
 * client.ts 未导出 put(现有模块的更新接口均为 PATCH),LLM 管理端更新接口为 @PutMapping,本地补齐。
 */
async function put<T>(url: string, body?: unknown): Promise<T> {
  const resp = await http.put<ApiResponse<T>>(url, body)
  return resp as unknown as T
}

/** 企业逻辑模型视图(对齐 EnterpriseModelDto) */
export interface EnterpriseModelDto {
  id: string
  displayName: string
  gatewayModelName: string
  modelParams: Record<string, unknown> | null
  reservationTokens: number
  enabled: boolean
  createdAt: string | null
  updatedAt: string | null
}

/** 月度额度授权视图(对齐 QuotaGrantDto) */
export interface QuotaGrantDto {
  id: string
  subjectType: string
  subjectId: string
  subjectName: string
  modelId: string
  modelDisplayName: string
  monthlyLimitTokens: number
  enabled: boolean
  effectiveFrom: string | null
  effectiveTo: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** 路由顺位项(对齐 UserModelRouteDto.RouteItemDto) */
export interface RouteItemDto {
  id: string
  priority: number
  sourceType: string
  sourceId: string
  sourceName: string
  enabled: boolean
}

/** 用户模型额度路由视图(对齐 UserModelRouteDto) */
export interface UserModelRouteDto {
  id: string
  userId: string
  userDisplayName: string
  modelId: string
  modelDisplayName: string
  exhaustAction: string
  enabled: boolean
  items: RouteItemDto[]
  createdAt: string | null
  updatedAt: string | null
}

/** 维度汇总行(对齐 LlmLedgerJdbcRepository.SummaryRow) */
export interface UsageSummaryRow {
  subjectId: string
  subjectName: string
  totalTokens: number
  promptTokens: number
  completionTokens: number
  overageTokens: number
  requestCount: number
}

/** 近一年消耗热力图的一天聚合(对齐 LlmLedgerJdbcRepository.DailyTotal) */
export interface UsageDailyTotal {
  date: string
  totalTokens: number
  requestCount: number
}

/** 用量账本明细(对齐 UsageLedgerEntry) */
export interface UsageLedgerEntry {
  id: string
  requestId: string
  usageMonth: string
  userId: string
  userDisplayName: string
  orgUnitId: string | null
  orgUnitName: string | null
  sourceType: string
  sourceId: string
  sourceName: string
  modelId: string
  modelDisplayName: string
  sessionId: string | null
  gatewayRequestId: string | null
  status: string
  reservedTokens: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  overageTokens: number
  estimatedCost: number | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string | null
  completedAt: string | null
}

/** 账本明细分页结果(后端 ledger 端点 Map 结构) */
export interface UsageLedgerPage {
  items: UsageLedgerEntry[]
  total: number
  page: number
  pageSize: number
}

/** 账本筛选下拉的一个可选项(对齐 LlmLedgerJdbcRepository.FilterOption) */
export interface UsageLedgerFilterOption {
  id: string
  name: string | null
  /** 仅 source 选项有值:user/org_unit */
  type: string | null
}

/** 账本筛选下拉全部选项(对齐 LlmLedgerJdbcRepository.LedgerFilterOptions);含已删除实体 */
export interface UsageLedgerFilterOptions {
  users: UsageLedgerFilterOption[]
  models: UsageLedgerFilterOption[]
  sources: UsageLedgerFilterOption[]
}

export interface CreateModelRequest {
  displayName: string
  gatewayModelName: string
  /** 约定键:contextWindow/maxTokens(正整数)、reasoning(布尔);员工端 DSH 读取 */
  modelParams?: Record<string, unknown>
  reservationTokens?: number
}

export interface UpdateModelRequest {
  displayName: string
  gatewayModelName: string
  /** 约定键:contextWindow/maxTokens(正整数)、reasoning(布尔);员工端 DSH 读取 */
  modelParams?: Record<string, unknown>
  reservationTokens?: number
}

export interface CreateGrantRequest {
  subjectType: string
  subjectId: string
  modelId: string
  monthlyLimitTokens?: number
  effectiveFrom?: string | null
  effectiveTo?: string | null
}

export interface UpdateGrantRequest {
  monthlyLimitTokens?: number
  effectiveFrom?: string | null
  effectiveTo?: string | null
}

export interface RouteItemParam {
  priority: number
  sourceType: string
  sourceId: string
}

export interface CreateRouteRequest {
  userId: string
  modelId: string
  exhaustAction: string
  items: RouteItemParam[]
}

export interface UpdateRouteRequest {
  exhaustAction?: string
  enabled?: boolean
  items?: RouteItemParam[]
}

export const llmApi = {
  // ---------- 企业模型 ----------
  listModels: () => get<EnterpriseModelDto[]>('/api/admin/llm/models'),
  // New API 模型名清单(/v1/models,转发令牌可路由集合),网关模型名的合法取值源
  listNewapiModels: () => get<string[]>('/api/admin/llm/newapi/models'),
  createModel: (body: CreateModelRequest) =>
    post<EnterpriseModelDto>('/api/admin/llm/models', body),
  updateModel: (id: string, body: UpdateModelRequest) =>
    put<EnterpriseModelDto>(`/api/admin/llm/models/${id}`, body),
  enableModel: (id: string) => post<EnterpriseModelDto>(`/api/admin/llm/models/${id}/enable`),
  disableModel: (id: string) => post<EnterpriseModelDto>(`/api/admin/llm/models/${id}/disable`),
  deleteModel: (id: string) => del<void>(`/api/admin/llm/models/${id}`),

  // ---------- 额度授权 ----------
  listGrants: (modelId?: string) =>
    get<QuotaGrantDto[]>('/api/admin/llm/quota-grants', modelId ? { modelId } : undefined),
  createGrant: (body: CreateGrantRequest) => post<QuotaGrantDto>('/api/admin/llm/quota-grants', body),
  updateGrant: (id: string, body: UpdateGrantRequest) =>
    put<QuotaGrantDto>(`/api/admin/llm/quota-grants/${id}`, body),
  enableGrant: (id: string) => post<QuotaGrantDto>(`/api/admin/llm/quota-grants/${id}/enable`),
  disableGrant: (id: string) => post<QuotaGrantDto>(`/api/admin/llm/quota-grants/${id}/disable`),

  // ---------- 用户模型路由 ----------
  listRoutes: (userId?: string) =>
    get<UserModelRouteDto[]>('/api/admin/llm/routes', userId ? { userId } : undefined),
  createRoute: (body: CreateRouteRequest) => post<UserModelRouteDto>('/api/admin/llm/routes', body),
  updateRoute: (id: string, body: UpdateRouteRequest) =>
    put<UserModelRouteDto>(`/api/admin/llm/routes/${id}`, body),

  // ---------- 用量分析 ----------
  usageSummary: (dimension: string, month: string) =>
    get<UsageSummaryRow[]>('/api/admin/llm/usage/summary', { dimension, month }),
  usageHeatmapYear: () => get<UsageDailyTotal[]>('/api/admin/llm/usage/heatmap/year'),
  usageLedger: (params: {
    /** ISO-8601 含时区;to 为排他上界 */
    from?: string
    to?: string
    userId?: string
    modelId?: string
    sourceType?: string
    sourceId?: string
    status?: string
    page?: number
    pageSize?: number
  }) => get<UsageLedgerPage>('/api/admin/llm/usage/ledger', params as Record<string, unknown>),
  usageLedgerFilters: () =>
    get<UsageLedgerFilterOptions>('/api/admin/llm/usage/ledger/filters'),
}
