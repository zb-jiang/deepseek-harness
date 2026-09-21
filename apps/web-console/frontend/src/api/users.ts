import { get, patch, post } from './client'

/** 用户所属部门项(对齐 com.dsh.console.orgunit.dto.UserOrgUnitDto)。 */
export interface UserOrgUnitDto {
  orgUnitId: string
  name: string
}

export interface UserDto {
  id: string
  authSubject: string
  loginName: string
  displayName: string | null
  email: string
  status: string
  platformRoles: string[]
  createdAt: string | null
  createdBy: string | null
  approvedAt: string | null
  approvedBy: string | null
  disabledAt: string | null
  disabledBy: string | null
  disabledReason: string | null
  lockedAt: string | null
  lockedBy: string | null
  lockedReason: string | null
  orgUnits: UserOrgUnitDto[]
}

export interface UpdateUserRequest {
  platformRoles: string[]
}

export interface UserActionRequest {
  reason?: string
}

export const usersApi = {
  list: (params?: { status?: string; offset?: number; limit?: number }) =>
    get<UserDto[]>('/api/users', params as Record<string, unknown>),
  me: () => get<UserDto | null>('/api/users/me'),
  get: (userId: string) => get<UserDto>(`/api/users/${userId}`),
  approve: (userId: string) => post<UserDto>(`/api/users/${userId}/approve`),
  disable: (userId: string, body?: UserActionRequest) => post<UserDto>(`/api/users/${userId}/disable`, body),
  lock: (userId: string, body?: UserActionRequest) => post<UserDto>(`/api/users/${userId}/lock`, body),
  activate: (userId: string) => post<UserDto>(`/api/users/${userId}/activate`),
  updateRoles: (userId: string, body: UpdateUserRequest) => patch<UserDto>(`/api/users/${userId}`, body),
  /** 全量覆盖分配所属部门(空数组=脱离所有组织线;负责人守卫见后端) */
  assignOrgUnits: (userId: string, orgUnitIds: string[]) =>
    patch<UserDto>(`/api/users/${userId}/org-units`, { orgUnitIds }),
}
