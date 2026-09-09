import { del, get, patch, post } from './client'

export interface ApplicationDto {
  id: string
  name: string
  description: string | null
  icon: string | null
  status: string
  appAdminUserIds: string[]
  createdAt: string | null
  createdBy: string | null
  archivedAt: string | null
  archivedBy: string | null
}

export interface CreateApplicationRequest {
  name: string
  description?: string
  icon?: string
  appAdminUserIds: string[]
}

export interface UpdateApplicationRequest {
  name?: string
  description?: string
  icon?: string
  appAdminUserIds?: string[]
}

export const appsApi = {
  list: (params?: { status?: string; offset?: number; limit?: number }) =>
    get<ApplicationDto[]>('/api/applications', params as Record<string, unknown>),
  get: (appId: string) => get<ApplicationDto>(`/api/applications/${appId}`),
  create: (body: CreateApplicationRequest) => post<ApplicationDto>('/api/applications', body),
  update: (appId: string, body: UpdateApplicationRequest) =>
    patch<ApplicationDto>(`/api/applications/${appId}`, body),
  archive: (appId: string) => del<ApplicationDto>(`/api/applications/${appId}`),
}
