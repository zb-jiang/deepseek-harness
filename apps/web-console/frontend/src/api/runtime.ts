import { get } from './client'

/** 我的组织身份项(对齐 com.dsh.console.orgunit.dto.OrgPositionDto)。 */
export interface OrgPositionDto {
  orgUnitId: string
  orgUnitName: string
  /** 到根路径(根在前,如「总公司 / 华东区 / A 部门」)。 */
  pathToRoot: string[]
}

export const runtimeApi = {
  /** 当前登录用户的组织身份清单(发起流程选身份用)。 */
  myOrgPositions: () => get<OrgPositionDto[]>('/api/runtime/my-org-positions'),
}
