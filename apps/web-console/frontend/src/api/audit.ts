import { get } from './client'

export interface AuditEventDto {
  id: string
  eventType: string
  targetType?: string | null
  targetUserId: string | null
  targetUserDisplayName?: string | null
  operatorId: string | null
  operatorDisplayName?: string | null
  details: Record<string, unknown> | null
  occurredAt: string | null
}

export const auditApi = {
  list: (params?: {
    eventType?: string
    operatorId?: string
    targetType?: string
    /** ISO-8601 起始时间(含下界) */
    from?: string
    /** ISO-8601 结束时间(排他上界,传结束日次日 0 点) */
    to?: string
    offset?: number
    limit?: number
  }) =>
    get<AuditEventDto[]>('/api/audit', params as Record<string, unknown>),
  listByUser: (userId: string, params?: { offset?: number; limit?: number }) =>
    get<AuditEventDto[]>(`/api/audit/by-user/${userId}`, params as Record<string, unknown>),
}
