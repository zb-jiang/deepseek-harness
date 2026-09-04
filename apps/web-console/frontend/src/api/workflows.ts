import { get, patch, post } from './client'

/**
 * 流程定义 DTO(对齐 com.dsh.console.workflow.dto.WorkflowDefinitionDto)。
 *
 * 状态机: draft → published → disabled;draft/published/disabled → archived。
 */
export interface WorkflowDefinitionDto {
  id: string
  appId: string
  name: string
  description: string | null
  status: string
  draftBpmnXml: string | null
  publishedDeploymentId: string | null
  publishedProcdefId: string | null
  createdAt: string | null
  createdBy: string | null
  updatedAt: string | null
  updatedBy: string | null
}

export interface CreateWorkflowRequest {
  appId: string
  name: string
  description?: string
}

export interface UpdateBpmnXmlRequest {
  draftBpmnXml: string
}

export interface UpdateWorkflowMetaRequest {
  name: string
  description?: string
}

export interface BpmnValidationResult {
  valid: boolean
  errors: string[]
}

export interface PublishResult {
  workflowDefinitionId: string
  deploymentId: string
  procdefId: string
}

export const workflowsApi = {
  list: (params?: { appId?: string; status?: string; offset?: number; limit?: number }) =>
    get<WorkflowDefinitionDto[]>('/api/workflows', params as Record<string, unknown>),
  get: (workflowId: string) => get<WorkflowDefinitionDto>(`/api/workflows/${workflowId}`),
  create: (body: CreateWorkflowRequest) => post<WorkflowDefinitionDto>('/api/workflows', body),
  updateDraftBpmn: (workflowId: string, body: UpdateBpmnXmlRequest) =>
    patch<WorkflowDefinitionDto>(`/api/workflows/${workflowId}/draft-bpmn`, body),
  updateMeta: (workflowId: string, body: UpdateWorkflowMetaRequest) =>
    patch<WorkflowDefinitionDto>(`/api/workflows/${workflowId}/meta`, body),
  validate: (workflowId: string) => post<BpmnValidationResult>(`/api/workflows/${workflowId}/validate`),
  publish: (workflowId: string) => post<PublishResult>(`/api/workflows/${workflowId}/publish`),
  disable: (workflowId: string) => post<WorkflowDefinitionDto>(`/api/workflows/${workflowId}/disable`),
  archive: (workflowId: string) => post<WorkflowDefinitionDto>(`/api/workflows/${workflowId}/archive`),
}
