import { del, get, patch, post } from './client'

/** 部门树节点(嵌套;后端 /api/org-units 返回) */
export interface OrgUnitTreeNode {
  id: string
  name: string
  parentId: string | null
  headUserId: string | null
  headUserName: string | null
  sortOrder: number
  children: OrgUnitTreeNode[]
}

/** 部门创建/更新请求(全量覆盖写) */
export interface SaveOrgUnitRequest {
  name: string
  parentId?: string | null
  headUserId?: string | null
  sortOrder?: number | null
}

/** 部门成员明细行(成员面板) */
export interface OrgUnitMemberDto {
  userId: string
  loginName: string
  displayName: string
  status: string
}

export const orgUnitsApi = {
  /** 部门树(嵌套,含负责人显示名) */
  tree: () => get<OrgUnitTreeNode[]>('/api/org-units'),
  create: (body: SaveOrgUnitRequest) => post<unknown>('/api/org-units', body),
  update: (orgUnitId: string, body: SaveOrgUnitRequest) =>
    patch<unknown>(`/api/org-units/${orgUnitId}`, body),
  remove: (orgUnitId: string) => del<void>(`/api/org-units/${orgUnitId}`),
  /** 部门成员明细(系统/应用管理员) */
  members: (orgUnitId: string) => get<OrgUnitMemberDto[]>(`/api/org-units/${orgUnitId}/members`),
  /** 批量加入成员(幂等,返回加入后成员全量) */
  addMembers: (orgUnitId: string, userIds: string[]) =>
    post<OrgUnitMemberDto[]>(`/api/org-units/${orgUnitId}/members`, { userIds }),
  /** 移出单个成员(负责人守卫,返回移出后成员全量) */
  removeMember: (orgUnitId: string, userId: string) =>
    del<OrgUnitMemberDto[]>(`/api/org-units/${orgUnitId}/members/${userId}`),
}
