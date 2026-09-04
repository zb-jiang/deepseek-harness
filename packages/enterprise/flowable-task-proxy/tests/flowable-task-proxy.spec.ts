import { Context } from '@deepseek-ai/cordis'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'

const { apply } = await import('../src/index.ts')

/** 最小 WebServer 桩，收集注册的路由。 */
function createStubWebServer() {
  const routes: {
    kind: string
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }[] = []
  const stub = {
    routes,
    register(route: (typeof routes)[number]) {
      routes.push(route)
      return () => {
        const idx = routes.indexOf(route)
        if (idx >= 0) routes.splice(idx, 1)
      }
    },
    registerUpgrade() { return () => {} },
    registerFallback() { return () => {} },
    tapIndex() { return () => {} },
    applyIndexTaps(html: string) { return html },
    host: '127.0.0.1' as const,
    port: 0,
  }
  return stub
}

/** 模拟 IncomingMessage：携带可选请求体的异步可迭代对象。 */
function mockReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  } as unknown as IncomingMessage
}

/** 模拟 ServerResponse，通过对象引用读取 statusCode、headers 和 body。 */
function mockRes() {
  const state: { statusCode: number; headers: Record<string, unknown>; body: Buffer | string | undefined } = {
    statusCode: 0,
    headers: {},
    body: undefined,
  }
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      state.statusCode = status
      state.headers = headers ?? {}
    },
    end(data?: Buffer | string) { state.body = data },
  } as unknown as ServerResponse
  return { res, state }
}

/** 构造一个 upstream Response 对象。Uint8Array 体不会触发 Response 构造器的默认 content-type。 */
function upstreamResponse(status: number, body: string, contentType?: string): Response {
  const headers = new Headers(contentType === undefined ? {} : { 'content-type': contentType })
  return new Response(new TextEncoder().encode(body), { status, headers })
}

const CONFIG = { engineBaseUrl: 'http://engine:8090' }

describe('flowable-task-proxy', () => {
  let ctx: Context
  let stubWebServer: ReturnType<typeof createStubWebServer>

  beforeEach(() => {
    ctx = new Context()
    stubWebServer = createStubWebServer()
    ctx.provide('webServer', stubWebServer as unknown as import('@deepseek-ai/dsh-host-webserver').WebServer)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('注册 /dsh/tasks 与 /dsh/history 两条前缀路由', () => {
    apply(ctx, CONFIG)
    expect(stubWebServer.routes).toHaveLength(2)
    expect(stubWebServer.routes.map(r => r.path)).toEqual(['/dsh/tasks', '/dsh/history'])
    for (const route of stubWebServer.routes) {
      expect(route.kind).toBe('prefix')
    }
  })

  it('engineBaseUrl 带尾斜杠时归一化后再使用', () => {
    apply(ctx, { engineBaseUrl: 'http://engine:8090///' })
    expect(stubWebServer.routes).toHaveLength(2)
  })

  it('engineBaseUrl 非法时 apply 立即抛错', () => {
    expect(() => apply(ctx, { engineBaseUrl: 'not-a-url' })).toThrow()
    expect(stubWebServer.routes).toHaveLength(0)
  })

  it('GET 请求转发路径、Authorization 头与查询串', async () => {
    apply(ctx, CONFIG)
    const fetchMock = vi.fn(async () => upstreamResponse(200, JSON.stringify([{ id: 't1' }]), 'application/json'))
    vi.stubGlobal('fetch', fetchMock)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(
      mockReq('GET', '/dsh/tasks/my-tasks?active=true', { authorization: 'Bearer jwt-token' }),
      res,
    )
    expect(fetchMock).toHaveBeenCalledOnce()
    const [target, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(target)).toBe('http://engine:8090/dsh/tasks/my-tasks?active=true')
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    expect(init.headers).toEqual({ authorization: 'Bearer jwt-token' })
    expect(state.statusCode).toBe(200)
    expect(state.headers['content-type']).toBe('application/json')
    expect(JSON.parse(String(state.body))).toEqual([{ id: 't1' }])
  })

  it('POST 请求转发 JSON 体与 content-type 头', async () => {
    apply(ctx, CONFIG)
    const fetchMock = vi.fn(async () => upstreamResponse(200, '{"ok":true}', 'application/json'))
    vi.stubGlobal('fetch', fetchMock)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(
      mockReq('POST', '/dsh/tasks/task-1/complete', { authorization: 'Bearer t', 'content-type': 'application/json' }, '{"variables":{}}'),
      res,
    )
    const [target, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(String(target)).toBe('http://engine:8090/dsh/tasks/task-1/complete')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toBe('{"variables":{}}')
    expect(init.headers).toEqual({ authorization: 'Bearer t', 'content-type': 'application/json' })
    expect(state.statusCode).toBe(200)
  })

  it('HEAD 请求不携带 body', async () => {
    apply(ctx, CONFIG)
    const fetchMock = vi.fn(async () => upstreamResponse(200, '', 'application/json'))
    vi.stubGlobal('fetch', fetchMock)
    const handler = stubWebServer.routes[0]!.handler
    const { res } = mockRes()
    await handler(mockReq('HEAD', '/dsh/tasks/my-tasks'), res)
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(init.body).toBeUndefined()
  })

  it('无 authorization 头时不转发该头', async () => {
    apply(ctx, CONFIG)
    const fetchMock = vi.fn(async () => upstreamResponse(200, '{}', 'application/json'))
    vi.stubGlobal('fetch', fetchMock)
    const handler = stubWebServer.routes[0]!.handler
    const { res } = mockRes()
    await handler(mockReq('GET', '/dsh/tasks/my-tasks'), res)
    const [, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit]
    expect(init.headers).toEqual({})
  })

  it('上游非 2xx 状态码原样透传', async () => {
    apply(ctx, CONFIG)
    vi.stubGlobal('fetch', vi.fn(async () => upstreamResponse(500, '{"error":"boom"}', 'application/json')))
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/dsh/tasks/my-tasks'), res)
    expect(state.statusCode).toBe(500)
    expect(JSON.parse(String(state.body))).toEqual({ error: 'boom' })
  })

  it('上游缺 content-type 时回退 application/json', async () => {
    apply(ctx, CONFIG)
    vi.stubGlobal('fetch', vi.fn(async () => upstreamResponse(200, '{}')))
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/dsh/tasks/my-tasks'), res)
    expect(state.headers['content-type']).toBe('application/json; charset=utf-8')
  })

  it('引擎不可达返回 502 JSON(Error)', async () => {
    apply(ctx, CONFIG)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }))
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/dsh/tasks/my-tasks'), res)
    expect(state.statusCode).toBe(502)
    const parsed = JSON.parse(String(state.body)) as { error: string }
    expect(parsed.error).toContain('flowable-engine unreachable at http://engine:8090')
    expect(parsed.error).toContain('ECONNREFUSED')
  })

  it('引擎不可达返回 502 JSON(非 Error 抛出值)', async () => {
    apply(ctx, CONFIG)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw 'boom'
    }))
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/dsh/tasks/my-tasks'), res)
    expect(state.statusCode).toBe(502)
    const parsed = JSON.parse(String(state.body)) as { error: string }
    expect(parsed.error).toContain('boom')
  })
})
