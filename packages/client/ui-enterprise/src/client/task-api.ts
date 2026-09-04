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
