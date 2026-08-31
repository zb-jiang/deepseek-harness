import { del, get, post } from './client'

/**
 * 流程实例 DTO(对齐 com.dsh.console.runtime.dto.ProcessInstanceDto)。
 *
 * 运行中实例 endTime/deleteReason 为 null;已结束实例补齐结束时间与终止原因。
 */
export interface ProcessInstanceDto {
  id: string
  businessKey: string | null
  processDefinitionId: string | null
  processDefinitionKey: string | null
  processDefinitionName: string | null
  name: string | null
  startUserId: string | null
  startTime: string | null
  suspended: boolean
  ended: boolean
  deleteReason: string | null
  endTime: string | null
  workflowDefinitionId: string | null
  appId: string | null
  workflowName: string | null
}

export interface StartProcessInstanceRequest {
  workflowDefinitionId: string
  businessKey?: string
  name?: string
  variables?: Record<string, unknown>
}

export interface TaskDto {
  id: string
  name: string | null
  assignee: string | null
  owner: string | null
  createTime: string | null
  dueDate: string | null
  processInstanceId: string
  processDefinitionId: string | null
  taskDefinitionKey: string | null
  description: string | null
}

export interface CompleteTaskRequest {
  variables?: Record<string, unknown>
}

export const instancesApi = {
  start: (body: StartProcessInstanceRequest) => post<ProcessInstanceDto>('/api/process-instances', body),
  list: (params?: { appId?: string; procdefId?: string; start?: number; size?: number }) =>
    get<ProcessInstanceDto[]>('/api/process-instances', params as Record<string, unknown>),
  get: (instanceId: string) => get<ProcessInstanceDto>(`/api/process-instances/${instanceId}`),
  listTasks: (instanceId: string) =>
    get<TaskDto[]>(`/api/process-instances/${instanceId}/tasks`),
  terminate: (instanceId: string, reason?: string) =>
    del<void>(`/api/process-instances/${instanceId}`, reason ? { reason } : undefined),
  completeTask: (instanceId: string, taskId: string, body?: CompleteTaskRequest) =>
    post<void>(`/api/process-instances/${instanceId}/tasks/${taskId}/complete`, body),
}
