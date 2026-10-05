/**
 * Flowable task API client for the enterprise profile task-completion plugin.
 *
 * <p>All endpoints live under {@code /dsh/tasks} on the local DSH webserver,
 * which proxies to the enterprise flowable-engine. Requests carry the
 * enterprise JWT from localStorage.
 */

const TOKEN_KEY = 'dsh.enterprise.token'

/** object 上下文变量的嵌套字段声明(名称/类型/说明/子字段)。 */
export type ContextVariableField = {
  name: string
  type: string
  description: string | null
  fields: ContextVariableField[] | null
}

/** 流程级上下文变量声明(名称/类型/说明/初始值/元素类型/来源/字段清单)。 */
export type ContextVariable = {
  name: string
  type: string
  description: string | null
  initialValue: string | null
  itemType: string | null
  source: string | null
  fields: ContextVariableField[] | null
}

/** 节点输出映射行(source 为输出 JSON 内点路径,target 为上下文变量路径)。 */
export type OutputMapping = {
  source: string | null
  target: string | null
}

/** 节点分配规则:候选角色 id,办理人为该角色全部成员。 */
export type AssignmentRule = {
  candidateRoleId: string | null
}

/** 超时策略:ISO-8601 时长与升级目标角色/用户。 */
export type TimeoutPolicy = {
  duration: string | null
  escalateToRoleId: string | null
  escalateToUserId: string | null
}

/** 责权分离(SoD)规则行:规则类型。 */
export type SodRule = {
  type: string
}

/** 节点动作策略:超时升级 + 责权分离。 */
export type ActionPolicy = {
  timeoutPolicy: TimeoutPolicy | null
  sodRules: SodRule[] | null
}

/** BPMN `dsh:` 扩展解析出的节点元数据(prompt/skill/输出映射/上下文声明)。 */
export type DshMeta = {
  assignmentRule: AssignmentRule | null
  userPrompt: string | null
  skillRefs: string[] | null
  actionPolicy: ActionPolicy | null
  outputMappings: OutputMapping[] | null
  contextVariables: ContextVariable[] | null
}

/** 员工名下的待办任务(引擎按当前 JWT 用户过滤)。 */
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
  /** 流程定义所属应用 id(UUID);员工端凭此定位应用知识库,未归属为 null。 */
  applicationId: string | null
}

/**
 * 已完成历史任务(/dsh/history/tasks?finished=true):引擎默认按当前 JWT
 * 用户过滤("我处理过的"),刷新页面后仍是持久真相(区别于本地内存回执)。
 */
export type CompletedTask = {
  id: string
  processInstanceId: string
  processDefinitionId: string
  /** 流程定义名(BPMN process name),已完成分组人读展示;定义不可查时为 null。 */
  processDefinitionName: string | null
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

/**
 * 读取企业 JWT(kb-api 等同域代理客户端复用)。
 * @returns localStorage 中的令牌;无令牌或非浏览器环境为 null。
 */
export function readToken(): string | null {
  if (typeof window === 'undefined') return null
  return window.localStorage.getItem(TOKEN_KEY)
}

/**
 * 从 JWT payload 中读取 sub claim(仅用于诊断显示,不做安全校验)。
 * @returns sub claim;无令牌、解析失败或无该 claim 为 null。
 */
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

/**
 * 查当前用户名下的待办任务(待办队列数据源)。
 * @returns 待办任务列表。
 */
export async function getMyTasks(): Promise<Task[]> {
  return fetchJson<Task[]>('/dsh/tasks/my-tasks')
}

/**
 * 查当前用户已完成的历史任务(侧栏"已完成"分组数据源,按完成时间倒序)。
 * @param size - 返回条数上限。
 * @returns 已完成历史任务列表。
 */
export async function getCompletedTasks(size = 20): Promise<CompletedTask[]> {
  return fetchJson<CompletedTask[]>(`/dsh/history/tasks?finished=true&size=${size}`)
}

/**
 * 按 id 查单条待办(档案栏刷新数据源)。
 * @param taskId - 待办任务 id。
 * @returns 待办任务详情。
 */
export async function getTask(taskId: string): Promise<Task> {
  return fetchJson<Task>(`/dsh/tasks/${taskId}`)
}

/**
 * 提交待办:把映射后的流程上下文变量写回引擎,待办完成、流程继续。
 * @param taskId - 待办任务 id。
 * @param variables - 员工确认后的最终映射变量。
 * @throws 引擎拒绝(校验失败/待办已不存在等)时原样抛出。
 */
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

/** skill 就绪检查响应:missing 为即时同步后仍不可用的 skill 裸名。 */
export type EnsureSkillsResponse = {
  missing: string[]
}

/**
 * 确保待办所需 skill 已安装(skill-repo-design §7 工作项 3):经本地
 * webserver 调 skill-sync 的即时安装端点,缺失时其内部先跑一轮同步。
 * @param names - 待办 dshMeta.skillRefs 去重后的 skill 裸名。
 * @returns 同步后仍缺失的名字(调用方走降级提示);请求本身失败时抛错。
 */
export async function ensureSkills(names: readonly string[]): Promise<string[]> {
  if (names.length === 0) return []
  const res = await fetchJson<EnsureSkillsResponse>('/api/enterprise/skills/ensure', {
    method: 'POST',
    body: JSON.stringify({ names: [...names] }),
  })
  return res.missing
}

/**
 * 查实例的历史活动(执行记录 + 迷你流程图高亮数据源)。
 * @param processInstanceId - 流程实例 id。
 * @returns 按时间序的历史活动列表。
 */
export async function getHistoricActivities(processInstanceId: string): Promise<HistoricActivity[]> {
  return fetchJson<HistoricActivity[]>(
    `/dsh/history/activities?processInstanceId=${encodeURIComponent(processInstanceId)}`,
  )
}

/**
 * 查实例的上下文变量当前值(与声明 schema 连接展示)。
 * @param processInstanceId - 流程实例 id。
 * @returns 变量记录列表。
 */
export async function getHistoricVariables(processInstanceId: string): Promise<HistoricVariable[]> {
  return fetchJson<HistoricVariable[]>(
    `/dsh/history/variables?processInstanceId=${encodeURIComponent(processInstanceId)}`,
  )
}

/**
 * 查流程定义的部署版 BPMN XML(迷你流程图按部署版渲染)。
 * @param processDefinitionId - 流程定义(部署版) id。
 * @returns BPMN XML 文本。
 */
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
