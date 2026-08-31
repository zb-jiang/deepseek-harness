import { del, get, patch, post } from './client'

export interface AppRoleDto {
  id: string
  appId: string
  name: string
  description: string | null
  status: string
  parentRoleId: string | null
  createdAt: string | null
  createdBy: string | null
}

export interface CreateAppRoleRequest {
  name: string
  description?: string
  parentRoleId?: string | null
}

export interface UpdateAppRoleRequest {
  name?: string
  description?: string
  parentRoleId?: string | null
}

export const rolesApi = {
  listByApp: (appId: string) => get<AppRoleDto[]>(`/api/applications/${appId}/roles`),
  get: (appId: string, roleId: string) =>
    get<AppRoleDto>(`/api/applications/${appId}/roles/${roleId}`),
  create: (appId: string, body: CreateAppRoleRequest) =>
    post<AppRoleDto>(`/api/applications/${appId}/roles`, body),
  update: (appId: string, roleId: string, body: UpdateAppRoleRequest) =>
    patch<AppRoleDto>(`/api/applications/${appId}/roles/${roleId}`, body),
  // 后端 disable 是 DELETE 方法(状态 → disabled,见 AppRoleController)
  disable: (appId: string, roleId: string) =>
    del<AppRoleDto>(`/api/applications/${appId}/roles/${roleId}`),
  activate: (appId: string, roleId: string) =>
    post<AppRoleDto>(`/api/applications/${appId}/roles/${roleId}/activate`),
}
