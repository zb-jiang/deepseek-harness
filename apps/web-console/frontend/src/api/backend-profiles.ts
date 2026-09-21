import { get } from './client'

/** DSH backend profile 活跃实例(web-console 注册表,design 2026-09-14 §5.2)。 */
export interface BackendProfileDto {
  id: string
  name: string
  url: string
  llmLabel: string | null
  workspaceLabel: string | null
  lastHeartbeatAt: string | null
  createdAt: string | null
}

export const backendProfilesApi = {
  /** 活跃实例列表(心跳 5 分钟内),backend task 属性面板下拉数据源。 */
  list: () => get<BackendProfileDto[]>('/api/backend-profiles'),
}
