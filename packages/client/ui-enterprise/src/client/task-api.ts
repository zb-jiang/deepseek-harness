/**
 * Flowable task API client for the enterprise profile task-completion plugin.
 *
 * <p>All endpoints live under {@code /dsh/tasks} on the local DSH webserver,
 * which proxies to the enterprise flowable-engine. Requests carry the
 * enterprise JWT from localStorage.
 */

const TOKEN_KEY = 'dsh.enterprise.token'

export type ContextVariableField = {
  name: string
  type: string
  description: string | null
  fields: ContextVariableField[] | null
}

export type ContextVariable = {
  name: string
  type: string
  description: string | null
  initialValue: string | null
  itemType: string | null
  source: string | null
  fields: ContextVariableField[] | null
}

export type OutputMapping = {
  source: string | null
  target: string | null
}

export type AssignmentRule = {
  candidateRoleId: string | null
}

export type TimeoutPolicy = {
  duration: string | null
  escalateToRoleId: string | null
  escalateToUserId: string | null
}

export type SodRule = {
  type: string
}

export type ActionPolicy = {
  timeoutPolicy: TimeoutPolicy | null
  sodRules: SodRule[] | null
}

export type DshMeta = {
  assignmentRule: AssignmentRule | null
  userPrompt: string | null
  skillRefs: string[] | null
  actionPolicy: ActionPolicy | null
  outputMappings: OutputMapping[] | null
  contextVariables: ContextVariable[] | null
}

export type Task = {
  id: string
  processInstanceId: string
  processDefinitionId: string
  taskDefinitionKey: string
  name: string | null
  assignee: string | null
  createTime: string
  dshMeta: DshMeta | null
  nodeId: string | null
  /** 流程定义名(BPMN process name),待办卡片人读展示。 */
  processDefinitionName: string | null
  /** 实例发起人 auth_subject(Supabase Auth sub)。 */
  startUserId: string | null
  /** 发起人显示名;未解析到为 null,前端回退显示 id。 */
  startUserName: string | null
}

/**
 * 已完成历史任务(/dsh/history/tasks?finished=true):引擎默认按当前 JWT
 * 用户过滤("我处理过的"),刷新页面后仍是持久真相(区别于本地内存回执)。
 */
export type CompletedTask = {
  id: string
  processInstanceId: string
  processDefinitionId: string
  taskDefinitionKey: string
  name: string | null
  assignee: string | null
  startTime: string
  endTime: string | null
  durationInMillis: number | null
  deleteReason: string | null
  dshMeta: DshMeta | null
  nodeId: string | null
}

/** 历史活动记录(/dsh/history/activities):流程已走过/正在走的全部节点。 */
export type HistoricActivity = {
  id: string
  processInstanceId: string
  processDefinitionId: string
  activityId: string
  activityName: string | null
  activityType: string
  assignee: string | null
  startTime: string | null
  endTime: string | null
  durationInMillis: number | null
}

/** 历史变量记录(/dsh/history/variables):实例上下文变量当前/最终值。 */
export type HistoricVariable = {
  id: string
  processInstanceId: string
  variableName: string
  variableTypeName: string
  /** JSON 值(标量/对象/数组/null;不可序列化值降级为字符串)。 */
  value: unknown
  createTime: string | null
  lastUpdatedTime: string | null
}

function readToken(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(TOKEN_KEY)
}

/** 从 JWT payload 中读取 sub claim(仅用于诊断显示,不做安全校验)。 */
export function readTokenSubject(): string | null {
  const token = readToken()
  if (token == null) return null
  try {
    const payload = token.split('.')[1]
    if (payload === undefined) return null
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const parsed = JSON.parse(json) as { sub?: string }
    return parsed.sub ?? null
  } catch {
    return null
  }
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const token = readToken()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined ?? {}),
  }
  if (token !== null) headers.authorization = `Bearer ${token}`
  const res = await fetch(input, { ...init, headers })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
  return res.json() as Promise<T>
}

export async function getMyTasks(): Promise<Task[]> {
  return fetchJson<Task[]>('/dsh/tasks/my-tasks')
}

/** 查当前用户已完成的历史任务(侧栏"已完成"分组数据源,按完成时间倒序)。 */
export async function getCompletedTasks(size = 20): Promise<CompletedTask[]> {
  return fetchJson<CompletedTask[]>(`/dsh/history/tasks?finished=true&size=${size}`)
}

export async function getTask(taskId: string): Promise<Task> {
  return fetchJson<Task>(`/dsh/tasks/${taskId}`)
}

export async function completeTask(
  taskId: string,
  variables: Record<string, unknown>,
): Promise<void> {
  const token = readToken()
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (token !== null) headers.authorization = `Bearer ${token}`
  const res = await fetch(`/dsh/tasks/${taskId}/complete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ variables }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
}

/** 查实例的历史活动(执行记录 + 迷你流程图高亮数据源)。 */
export async function getHistoricActivities(processInstanceId: string): Promise<HistoricActivity[]> {
  return fetchJson<HistoricActivity[]>(
    `/dsh/history/activities?processInstanceId=${encodeURIComponent(processInstanceId)}`,
  )
}

/** 查实例的上下文变量当前值(与声明 schema 连接展示)。 */
export async function getHistoricVariables(processInstanceId: string): Promise<HistoricVariable[]> {
  return fetchJson<HistoricVariable[]>(
    `/dsh/history/variables?processInstanceId=${encodeURIComponent(processInstanceId)}`,
  )
}

/** 查流程定义的部署版 BPMN XML(迷你流程图按部署版渲染)。 */
export async function getBpmnXml(processDefinitionId: string): Promise<string> {
  const token = readToken()
  const headers: Record<string, string> = {}
  if (token !== null) headers.authorization = `Bearer ${token}`
  const res = await fetch(
    `/dsh/history/bpmn-xml?processDefinitionId=${encodeURIComponent(processDefinitionId)}`,
    { headers },
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status} ${res.statusText}: ${text}`)
  }
  return res.text()
}
