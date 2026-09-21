/**
 * 员工端 AI 对话发起流程(design 2026-09-19 §5.1/§6.4)。
 *
 * 三个模型侧工具,在本地 webserver 进程内服务端直连 web-console REST,
 * 附当前登录员工的 Supabase JWT(`ctx.currentUser.getToken()`):
 *
 * 1. `dsh_process_list` — 列当前用户可发起的 published 流程(startable 视图)。
 * 2. `dsh_process_start_form` — 读一个流程的启动参数声明(start-param)。
 * 3. `dsh_process_start` — 发起流程实例(orgUnitId = 发起身份部门)。
 *
 * 工具调用与结果走普通注册表管线,落 session 事件(模型可见 ⟺ 已记录)。
 *
 * @module @deepseek-ai/dsh-process-start
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-identity-context'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'process-start'

/** 等待登录身份存储与工具注册表就绪后才挂载。 */
export const inject = ['currentUser', 'tools'] as const

/** web-console 基地址默认值(企业服务器常驻部署)。 */
const DEFAULT_WEB_CONSOLE_BASE_URL = 'http://127.0.0.1:8080'

/** 插件配置,来自 enterprise profile 的 cordis.yml config 段。 */
export interface Config {
  /** web-console 基地址(协议+主机+端口,无路径)。 */
  webConsoleBaseUrl: string
}

export const Config: z<Config> = z.object({
  webConsoleBaseUrl: z.string().default(DEFAULT_WEB_CONSOLE_BASE_URL),
})

/**
 * 已解析的运行选项(apply 阶段完成校验)。
 *
 * <p>token 取值函数注入而非内联,便于测试桩替换登录态。
 */
export interface ProcessStartOptions {
  /** web-console 基地址(无尾斜杠)。 */
  readonly webConsoleBaseUrl: string
  /** 当前登录员工的 Supabase JWT;未登录为 undefined。 */
  readonly token: () => string | undefined
}

/** web-console {@code ApiResponse} 信封(成功时 data 必有值)。 */
interface ApiEnvelope<T> {
  success?: boolean
  data?: T
  error?: { message?: string }
}

/** web-console {@code StartableWorkflowDto}(可发起流程 slim 视图)。 */
interface StartableWorkflowDto {
  id: string
  name: string
  description: string | null
  appId: string
  appName: string
}

/** web-console {@code StartFormVariableDto}(启动参数声明)。 */
interface StartFormVariableDto {
  name: string
  type: string
  description: string | null
  required: boolean
}

/** web-console {@code ProcessInstanceDto}(本插件只消费发起结果展示字段)。 */
interface ProcessInstanceDto {
  id: string
  name: string | null
  workflowName: string | null
  startTime: string
}

/**
 * 调 web-console 流程 REST 并解 {@code ApiResponse} 信封。
 *
 * @param options - 运行选项
 * @param path - 以 / 开头的绝对路径(不含 base)
 * @param init - POST 请求体;缺省按 GET 且无体
 * @returns 信封 data
 * @throws Error 未登录 / 网络不可达 / 响应非 JSON / 信封失败(错误消息面向模型呈现)
 */
async function requestJson<T>(
  options: ProcessStartOptions,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const token = options.token()
  if (token === undefined) {
    throw new Error('未登录,无法发起流程')
  }
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  if (init?.body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  let resp: Response
  try {
    resp = await fetch(new URL(path, options.webConsoleBaseUrl), {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined ? null : JSON.stringify(init.body),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`web-console 不可达(${options.webConsoleBaseUrl}): ${message}`)
  }
  let body: ApiEnvelope<T>
  try {
    body = await resp.json() as ApiEnvelope<T>
  } catch (error) {
    /* v8 ignore next 2 -- resp.json() only ever throws SyntaxError/TypeError,
    both Error instances; String(error) is unreachable defensive formatting. */
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`web-console 响应不是 JSON(HTTP ${resp.status}): ${message}`)
  }
  if (!resp.ok || body.success !== true || body.data === undefined) {
    throw new Error(`web-console 流程服务请求失败(HTTP ${resp.status}): ${body.error?.message ?? '未知错误'}`)
  }
  return body.data
}

/**
 * 注册 dsh_process_list / dsh_process_start_form / dsh_process_start 工具。
 *
 * <p>webConsoleBaseUrl 在注册前解析一次,格式非法立即失败(misconfiguration
 * fails loud)。工具经 {@code ctx.tools.register} 注册,随调用方 fiber 生命周期
 * 自动反注册。
 *
 * @param ctx - 携带 `currentUser` / `tools` 的 Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const webConsoleBaseUrl = config.webConsoleBaseUrl.replace(/\/+$/, '')
  new URL(webConsoleBaseUrl)
  const options: ProcessStartOptions = {
    webConsoleBaseUrl,
    token: () => ctx.currentUser.getToken(),
  }

  ctx.tools.register(defineTool({
    name: 'dsh_process_list',
    description: 'List the published workflow definitions the signed-in employee may start, with their owning '
      + 'application. To start a process in conversation: get the workflowDefinitionId here, read its start '
      + 'variables with dsh_process_start_form, collect required values from the user, then call dsh_process_start.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          workflows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                appName: { type: 'string', required: true },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.workflows.length === 0
            ? '当前没有你可发起的流程。'
            : `可发起流程 ${value.workflows.length} 个:\n${
              value.workflows
                .map(w => `- ${w.name} (id: ${w.id}, 应用: ${w.appName})${w.description === undefined ? '' : `\n  说明: ${w.description}`}`)
                .join('\n')
            }`,
        },
      ],
    },
    async execute() {
      const workflows = await requestJson<StartableWorkflowDto[]>(options, '/api/process-instances/startable')
      return {
        workflows: workflows.map(workflow => ({
          id: workflow.id,
          name: workflow.name,
          appName: workflow.appName,
          ...(workflow.description ? { description: workflow.description } : {}),
        })),
      }
    },
    presentCall: () => ({ card: 'generic', title: '列可发起流程', kind: 'fetch' }),
  }))

  ctx.tools.register(defineTool({
    name: 'dsh_process_start_form',
    description: 'Read the start-form variable declarations (name, type, description, required) of one published '
      + 'workflow definition before starting it. Collect required variables from the user, then pass them as the '
      + 'variables object of dsh_process_start.',
    parameters: {
      workflowDefinitionId: { type: 'string', required: true, description: 'Workflow definition id from dsh_process_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          variables: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                type: { type: 'string', required: true },
                required: { type: 'boolean', required: true },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.variables.length === 0
            ? '该流程没有启动参数声明,可直接发起。'
            : `流程启动参数 ${value.variables.length} 个:\n${
              value.variables
                .map(v => `- ${v.name}(${v.type}${v.required ? ',必填' : ''})${v.description === undefined ? '' : ` ${v.description}`}`)
                .join('\n')
            }`,
        },
      ],
    },
    async execute(args) {
      const form = await requestJson<StartFormVariableDto[]>(
        options,
        `/api/process-instances/start-form?workflowDefinitionId=${encodeURIComponent(args.workflowDefinitionId)}`,
      )
      return {
        variables: form.map(variable => ({
          name: variable.name,
          type: variable.type,
          required: variable.required,
          ...(variable.description ? { description: variable.description } : {}),
        })),
      }
    },
    presentCall: args => ({ card: 'generic', title: '读流程启动参数', kind: 'read', rawInput: args.workflowDefinitionId }),
  }))

  ctx.tools.register(defineTool({
    name: 'dsh_process_start',
    description: 'Start a process instance. workflowDefinitionId comes from dsh_process_list; variables must satisfy '
      + 'the dsh_process_start_form declarations (values matching the declared types). orgUnitId is the 发起身份 org '
      + 'position: when the identity block in context lists several org positions, ask the user which one to start as '
      + 'and pass its orgUnitId; with exactly one position pass its orgUnitId; with none omit it. businessKey and name '
      + 'are optional.',
    parameters: {
      workflowDefinitionId: { type: 'string', required: true, description: 'Workflow definition id from dsh_process_list.' },
      orgUnitId: { type: 'string', description: 'Org unit id of the chosen 发起身份; required only when the identity block lists several org positions (ask the user).' },
      variables: { type: 'object', additionalProperties: true, description: 'Start variables keyed by declared variable name, values matching the declared types.' },
      businessKey: { type: 'string', description: 'Optional business key (e.g. an order number).' },
      name: { type: 'string', description: 'Optional instance name.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          instanceId: { type: 'string', required: true },
          startTime: { type: 'string', required: true },
          name: { type: 'string' },
          workflowName: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `流程实例已发起(实例 id: ${value.instanceId}`
            + `${value.name === undefined ? '' : `,实例名: ${value.name}`}`
            + `${value.workflowName === undefined ? '' : `,流程: ${value.workflowName}`})。`,
        },
      ],
    },
    async execute(args) {
      const body: Record<string, unknown> = { workflowDefinitionId: args.workflowDefinitionId }
      if (args.orgUnitId !== undefined) body.orgUnitId = args.orgUnitId
      if (args.businessKey !== undefined) body.businessKey = args.businessKey
      if (args.name !== undefined) body.name = args.name
      if (args.variables !== undefined) body.variables = args.variables
      const instance = await requestJson<ProcessInstanceDto>(options, '/api/process-instances', {
        method: 'POST',
        body,
      })
      return {
        instanceId: instance.id,
        startTime: instance.startTime,
        ...(instance.name ? { name: instance.name } : {}),
        ...(instance.workflowName ? { workflowName: instance.workflowName } : {}),
      }
    },
    presentCall: args => ({ card: 'generic', title: '发起流程', kind: 'execute', rawInput: args.name ?? args.workflowDefinitionId }),
  }))
}
