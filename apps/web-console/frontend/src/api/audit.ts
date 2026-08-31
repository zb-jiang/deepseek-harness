import { get } from './client'

export interface AuditEventDto {
  id: string
  eventType: string
  targetUserId: string | null
  operatorId: string | null
  details: Record<string, unknown> | null
  occurredAt: string | null
}

export const auditApi = {
  list: (params?: { eventType?: string; operatorId?: string; offset?: number; limit?: number }) =>
    get<AuditEventDto[]>('/api/audit', params as Record<string, unknown>),
  listByUser: (userId: string, params?: { offset?: number; limit?: number }) =>
    get<AuditEventDto[]>(`/api/audit/by-user/${userId}`, params as Record<string, unknown>),
}
