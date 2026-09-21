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

export const orgUnitsApi = {
  /** 部门树(嵌套,含负责人显示名) */
  tree: () => get<OrgUnitTreeNode[]>('/api/org-units'),
  create: (body: SaveOrgUnitRequest) => post<unknown>('/api/org-units', body),
  update: (orgUnitId: string, body: SaveOrgUnitRequest) =>
    patch<unknown>(`/api/org-units/${orgUnitId}`, body),
  remove: (orgUnitId: string) => del<void>(`/api/org-units/${orgUnitId}`),
}
