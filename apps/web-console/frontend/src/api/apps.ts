import { del, get, patch, post } from './client'

export interface ApplicationDto {
  id: string
  name: string
  description: string | null
  icon: string | null
  status: string
  appAdminUserIds: string[]
  skillhubNamespace?: string | null
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
  /** null = 不更新;空串 = 清除绑定;更新时 name 仍必填(后端 @NotBlank)。 */
  skillhubNamespace?: string | null
}

/** SkillHub skill 清单项(应用绑定命名空间下已发布的 skill)。 */
export interface SkillHubSkillDto {
  slug: string
  version: string
  fingerprint: string
  updatedAt: string
}

export const appsApi = {
  list: (params?: { status?: string; offset?: number; limit?: number }) =>
    get<ApplicationDto[]>('/api/applications', params as Record<string, unknown>),
  get: (appId: string) => get<ApplicationDto>(`/api/applications/${appId}`),
  create: (body: CreateApplicationRequest) => post<ApplicationDto>('/api/applications', body),
  update: (appId: string, body: UpdateApplicationRequest) =>
    patch<ApplicationDto>(`/api/applications/${appId}`, body),
  archive: (appId: string) => del<ApplicationDto>(`/api/applications/${appId}`),
  /** 应用绑定的 SkillHub 命名空间下已发布的 skill 清单。 */
  listSkills: (appId: string) =>
    get<SkillHubSkillDto[] | null>(`/api/applications/${appId}/skills`),
}
