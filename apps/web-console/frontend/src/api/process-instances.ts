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
  startUserName: string | null
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
  /** 发起身份部门 id:多组织身份时必传(后端校验须在本人归属列表中);唯一身份可省略 */
  orgUnitId?: string
  variables?: Record<string, unknown>
}

/**
 * 任务 DTO(运行时 + 历史统一)。
 *
 * 运行时任务 endTime/deleteReason 为 null;历史任务(已结束实例的任务列表)补齐。
 */
export interface TaskDto {
  id: string
  name: string | null
  assignee: string | null
  assigneeName: string | null
  owner: string | null
  createTime: string | null
  dueDate: string | null
  processInstanceId: string
  processDefinitionId: string | null
  taskDefinitionKey: string | null
  description: string | null
  endTime: string | null
  deleteReason: string | null
}

/** 流程实例上下文变量(运行中返回当前值,已结束返回终值)。 */
export interface ProcessVariableDto {
  name: string
  type: string | null
  value: unknown
  createTime: string | null
  lastUpdatedTime: string | null
}

/** 历史活动(执行路径回溯,含 sequenceFlow 连线)。 */
export interface HistoricActivityDto {
  id: string
  activityId: string
  activityName: string | null
  activityType: string
  assignee: string | null
  assigneeName: string | null
  startTime: string | null
  endTime: string | null
  durationInMillis: number | null
}

export interface CompleteTaskRequest {
  variables?: Record<string, unknown>
}

/** 启动表单变量项(对齐 com.dsh.console.runtime.dto.StartFormVariableDto)。 */
export interface StartFormVariableDto {
  name: string
  type: string
  description: string | null
  required: boolean
}

export const instancesApi = {
  start: (body: StartProcessInstanceRequest) => post<ProcessInstanceDto>('/api/process-instances', body),
  /** 启动表单变量清单(已部署 BPMN 的 start-param 声明)。 */
  startForm: (workflowDefinitionId: string) =>
    get<StartFormVariableDto[]>('/api/process-instances/start-form', { workflowDefinitionId }),
  /**
   * 列实例。state 不传查全部(运行中 + 已结束);running 只看运行中;
   * completed 只看正常完成;terminated 只看已终止。
   */
  list: (params?: { appId?: string; procdefId?: string; state?: string; start?: number; size?: number }) =>
    get<ProcessInstanceDto[]>('/api/process-instances', params as Record<string, unknown>),
  get: (instanceId: string) => get<ProcessInstanceDto>(`/api/process-instances/${instanceId}`),
  /** 列实例任务(已结束实例返回历史任务,含完成时间/终止原因)。 */
  listTasks: (instanceId: string) =>
    get<TaskDto[]>(`/api/process-instances/${instanceId}/tasks`),
  /** 列实例上下文变量(历史变量统一视图)。 */
  listVariables: (instanceId: string) =>
    get<ProcessVariableDto[]>(`/api/process-instances/${instanceId}/variables`),
  /** 列实例历史活动(执行路径回溯)。 */
  listActivities: (instanceId: string) =>
    get<HistoricActivityDto[]>(`/api/process-instances/${instanceId}/activities`),
  /** 取实例部署版 BPMN XML(活动路径图渲染用)。 */
  getBpmnXml: (instanceId: string) =>
    get<string>(`/api/process-instances/${instanceId}/bpmn-xml`),
  terminate: (instanceId: string, reason?: string) =>
    del<void>(`/api/process-instances/${instanceId}`, reason ? { reason } : undefined),
  completeTask: (instanceId: string, taskId: string, body?: CompleteTaskRequest) =>
    post<void>(`/api/process-instances/${instanceId}/tasks/${taskId}/complete`, body),
}
