import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import * as backendTask from '../src/index.ts'

const { apply } = backendTask

/** 构造 JSON Response。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** webServer 桩:记录注册的路由,测试直调 handler。 */
type StubRoute = {
  kind: 'prefix'
  path: string
  handler: (req: EventEmitter & { method: string; url: string }, res: unknown) => void | Promise<void>
}

function stubWebServer() {
  const routes: StubRoute[] = []
  return {
    routes,
    register: (route: StubRoute) => {
      routes.push(route)
      return () => {}
    },
  }
}

/** turn/end reason 形状(仅测试需要的字段)。 */
interface TurnEndReason {
  kind: string
  error?: { code: string; message: string }
}

/** 可脚本化的假 Agent 会话日志。 */
class StubSessionLog {
  readonly events: { type: string; data: unknown }[] = []

  get seq(): number {
    return this.events.length
  }

  eventAt(seq: number): { type: string; data: unknown } | undefined {
    return this.events[Number(seq)]
  }
}

/** agents 注册表桩:followup 时把最终 assistant 文本与 turn 结局写进会话日志。 */
function stubAgents(finalText: string, reason: TurnEndReason) {
  const created: { promptMessages: string[] }[] = []
  return {
    created,
    create: async () => {
      const session = new StubSessionLog()
      const promptMessages: string[] = []
      const agent = {
        session,
        whenIdle: async () => {},
        followup: (message: { content: { type: string; text: string }[] }) => {
          promptMessages.push(message.content.map(block => block.text).join(''))
          session.events.push(
            { type: 'turn/start', data: {} },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: finalText }] } } },
            { type: 'turn/end', data: { reason } },
          )
        },
      }
      created.push({ promptMessages })
      return { agent, dispose: async () => {} }
    },
  }
}

/** sessions 存储桩:flush 即成功。 */
function stubSessions() {
  return { flush: async () => true }
}

/** 默认模型桩:固定选择。 */
function stubDefaultModel() {
  return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
}

/** skills 注册表桩:记录 provider 注册。 */
function stubSkills() {
  const providers: unknown[] = []
  return {
    providers,
    registerProvider: (create: (control: unknown) => unknown) => {
      providers.push(create({ invalidate: () => {} }))
      return () => {}
    },
  }
}

/** 端点请求桩:Emitter 形状 + 异步迭代器(readJsonBody 整体缓冲请求体)。 */
function stubRequest(method: string, url: string, body?: Buffer) {
  const req = new EventEmitter() as EventEmitter & {
    method: string
    url: string
    [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>
  }
  req.method = method
  req.url = url
  req[Symbol.asyncIterator] = async function* () {
    if (body !== undefined) yield body
  }
  return req
}

/** 端点响应桩:记录状态码、响应头与响应体。 */
function stubResponse() {
  const res = {
    status: 0,
    headers: {} as Record<string, unknown>,
    body: '',
    writeHead: (status: number, headers?: Record<string, unknown>) => {
      res.status = status
      res.headers = headers ?? {}
    },
    end: (chunk?: unknown) => {
      res.body += String(chunk ?? '')
    },
    get headersSent(): boolean {
      return res.status !== 0
    },
  }
  return res
}

/** proxyRequest 转发给 fetch 的初始化参数。 */
interface StubFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: string
}

/** 按前缀分发的 fetch 桩。 */
function stubFetch(routes: { match: (url: string) => boolean; response: () => Response }[]) {
  return vi.fn(async (input: URL | RequestInfo, _init?: StubFetchInit) => {
    const url = String(input)
    for (const route of routes) {
      if (route.match(url)) return route.response()
    }
    return jsonResponse(404, { error: `unexpected fetch ${url}` })
  })
}

/** web-console register/skills 端点桩(心跳与空聚合)。 */
const consoleRoutes = () => [
  {
    match: (url: string) => url === 'http://console:8080/api/backend-profiles/register',
    response: () => jsonResponse(200, { success: true, data: null }),
  },
  {
    match: (url: string) => url.startsWith('http://console:8080/api/backend-profiles/skills'),
    response: () => jsonResponse(200, { success: true, data: [] }),
  },
]

const CONFIG = {
  webConsoleBaseUrl: 'http://console:8080/',
  selfUrl: 'http://backend-1:3190/',
  backendName: 'backend-1',
  skillhubBaseUrl: 'http://skillhub:8095',
  skillhubToken: '',
  syncIntervalMs: 100_000,
  registerIntervalMs: 100_000,
}

describe('backend-task', () => {
  let ctx: Context
  let skillDir: string

  const mount = (finalText: string, reason: TurnEndReason = { kind: 'completed' }, fetchMock = stubFetch(consoleRoutes())) => {
    vi.stubGlobal('fetch', fetchMock)
    const webServer = stubWebServer()
    ctx.provide('agents', stubAgents(finalText, reason) as never)
    ctx.provide('sessions', stubSessions() as never)
    ctx.provide('agentDefaultModel', stubDefaultModel() as never)
    ctx.provide('skills', stubSkills() as never)
    ctx.provide('webServer', webServer as never)
    apply(ctx, { ...CONFIG, skillDir })
    const route = webServer.routes.find(candidate => candidate.path === '/api/backend/tasks')
    if (route === undefined) throw new Error('task route not registered')
    return { route, fetchMock }
  }

  /** 提交一个任务,返回 taskId。 */
  const submit = async (route: StubRoute, prompt: string, skillRefs?: string[]) => {
    const res = stubResponse()
    await route.handler(
      stubRequest('POST', '/api/backend/tasks', Buffer.from(JSON.stringify({ prompt, skillRefs }))),
      res as never as ServerResponse,
    )
    return { res, taskId: (JSON.parse(res.body) as { taskId: string }).taskId }
  }

  /** 轮询任务直到非 running(内存任务结算全在微任务里,setImmediate 刷几轮即够)。 */
  const pollTask = async (route: StubRoute, taskId: string) => {
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setImmediate(resolve))
      const res = stubResponse()
      await route.handler(
        stubRequest('GET', `/api/backend/tasks/${taskId}`) as never,
        res as never as ServerResponse,
      )
      const body = JSON.parse(res.body) as { status: string; result?: unknown; error?: string }
      if (body.status !== 'running') return body
    }
    throw new Error('task still running after flush')
  }

  beforeEach(async () => {
    ctx = new Context()
    skillDir = join(await mkdtemp(join(tmpdir(), 'backend-task-')), 'skills')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('apply 注册任务路由并向 web-console 心跳注册(带 selfUrl/名称/模型)', async () => {
    const { fetchMock } = mount('{"ok":true}')
    await new Promise(resolve => setImmediate(resolve))
    const registerCall = fetchMock.mock.calls
      .map(([input, init]) => ({ url: String(input), init: init as RequestInit | undefined }))
      .find(call => call.url === 'http://console:8080/api/backend-profiles/register')
    expect(registerCall).toBeDefined()
    expect(registerCall?.init?.method).toBe('POST')
    const body = JSON.parse(String(registerCall?.init?.body)) as Record<string, unknown>
    expect(body.url).toBe('http://backend-1:3190')
    expect(body.name).toBe('backend-1')
    expect(body.llmLabel).toBe('deepseek-flash')
  })

  it('任务生命周期:POST 202 → 会话跑完 → GET ready 且 result 为提取的 JSON', async () => {
    const { route } = mount('前置说明\n{"amount": 42, "items": [1, 2]}\n补充')
    const { res, taskId } = await submit(route, '请提取金额')
    expect(res.status).toBe(202)
    const body = await pollTask(route, taskId)
    expect(body.status).toBe('ready')
    expect(body.result).toEqual({ amount: 42, items: [1, 2] })
  })

  it('skillRefs 作为提示前缀进入会话首条 user message', async () => {
    const agents = stubAgents('{"a":1}', { kind: 'completed' })
    vi.stubGlobal('fetch', stubFetch(consoleRoutes()))
    const webServer = stubWebServer()
    ctx.provide('agents', agents as never)
    ctx.provide('sessions', stubSessions() as never)
    ctx.provide('agentDefaultModel', stubDefaultModel() as never)
    ctx.provide('skills', stubSkills() as never)
    ctx.provide('webServer', webServer as never)
    apply(ctx, { ...CONFIG, skillDir })
    const route = webServer.routes.find(candidate => candidate.path === '/api/backend/tasks')!
    const { taskId } = await submit(route, '做提取', ['invoice-extract', 'ocr'])
    await pollTask(route, taskId)
    expect(agents.created[0]!.promptMessages[0]).toContain('invoice-extract、ocr')
    expect(agents.created[0]!.promptMessages[0]).toContain('做提取')
  })

  it('失败路径:turn/end error → failed 携带错误文本', async () => {
    const { route } = mount('ignored', { kind: 'error', error: { code: 'E_LLM', message: 'boom' } })
    const { taskId } = await submit(route, '任意')
    const body = await pollTask(route, taskId)
    expect(body.status).toBe('failed')
    expect(body.error).toBe('E_LLM: boom')
  })

  it('失败路径:输出不含 JSON → failed 且不吞重试语义', async () => {
    const { route } = mount('抱歉,我无法完成该任务。')
    const { taskId } = await submit(route, '任意')
    const body = await pollTask(route, taskId)
    expect(body.status).toBe('failed')
    expect(body.error).toBe('模型输出中不含合法 JSON 对象')
  })

  it('提交校验:空 prompt / 非法 skillRefs → 400', async () => {
    const { route } = mount('{"a":1}')
    const bad = stubResponse()
    await route.handler(
      stubRequest('POST', '/api/backend/tasks', Buffer.from('{"prompt": "  "}')) as never,
      bad as never as ServerResponse,
    )
    expect(bad.status).toBe(400)
    const badRefs = stubResponse()
    await route.handler(
      stubRequest('POST', '/api/backend/tasks', Buffer.from('{"prompt": "p", "skillRefs": [1]}')) as never,
      badRefs as never as ServerResponse,
    )
    expect(badRefs.status).toBe(400)
  })

  it('未知任务与未知路由 → 404', async () => {
    const { route } = mount('{"a":1}')
    const res = stubResponse()
    await route.handler(
      stubRequest('GET', '/api/backend/tasks/no-such-id') as never,
      res as never as ServerResponse,
    )
    expect(res.status).toBe(404)
    const badRoute = stubResponse()
    await route.handler(
      stubRequest('DELETE', '/api/backend/tasks') as never,
      badRoute as never as ServerResponse,
    )
    expect(badRoute.status).toBe(404)
  })

  it('apply 校验配置:非法 baseUrl 与非正数间隔立即抛错(misconfiguration fails loud)', () => {
    vi.stubGlobal('fetch', stubFetch([]))
    ctx.provide('agents', stubAgents('{}', { kind: 'completed' }) as never)
    ctx.provide('sessions', stubSessions() as never)
    ctx.provide('agentDefaultModel', stubDefaultModel() as never)
    ctx.provide('skills', stubSkills() as never)
    ctx.provide('webServer', stubWebServer() as never)
    expect(() => apply(ctx, { ...CONFIG, skillDir, webConsoleBaseUrl: 'not-a-url' })).toThrow()
    expect(() => apply(ctx, { ...CONFIG, skillDir, selfUrl: 'not-a-url' })).toThrow()
    expect(() => apply(ctx, { ...CONFIG, skillDir, registerIntervalMs: 0 })).toThrow('registerIntervalMs')
    expect(() => apply(ctx, { ...CONFIG, skillDir, syncIntervalMs: -1 })).toThrow('syncIntervalMs')
  })
})
