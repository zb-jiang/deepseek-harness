import { Context } from '@deepseek-ai/cordis'
import { describe, it, expect, beforeEach } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-platform-user'
import type { PlatformUser, PlatformUserId } from '@deepseek-ai/dsh-platform-user'
import { PlatformUserError } from '@deepseek-ai/dsh-platform-user'

const { apply } = await import('../src/index.ts')

/** 最小 WebServer 桩，收集注册的路由。 */
function createStubWebServer() {
  const routes: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }[] = []
  const stub = {
    routes,
    register(route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
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

/** 最小 PlatformUsers 桩，只实现 getUserByToken。 */
function createStubPlatformUsers() {
  const tokenToUser = new Map<string, PlatformUser>()
  const alice: PlatformUser = {
    id: 'u1' as PlatformUserId,
    authSubject: 'auth-1',
    loginName: 'alice',
    displayName: 'Alice',
    email: 'alice@example.com',
    status: 'active',
    platformRoles: ['normal_user'],
    createdAt: '2026-08-30T00:00:00.000Z',
  }
  tokenToUser.set('valid-token', alice)
  return {
    async getUserByToken(accessToken: string) {
      const user = tokenToUser.get(accessToken)
      if (user === undefined) {
        throw new PlatformUserError('invalid token', 'AUTH_TOKEN_INVALID')
      }
      return user
    },
  }
}

/** 模拟 IncomingMessage。 */
function mockReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    method,
    url,
    headers,
  } as unknown as IncomingMessage
}

/** 模拟 ServerResponse，通过对象引用读取 statusCode 和 body。 */
function mockRes() {
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(status: number, _headers?: Record<string, unknown>) { state.statusCode = status },
    end(data?: string) { state.body = data ?? '' },
  } as unknown as ServerResponse
  return { res, state }
}

const TEST_CONFIG = {
  supabaseUrl: 'https://example.supabase.co',
  supabaseAnonKey: 'anon-secret',
}

describe('platform-user-api', () => {
  let ctx: Context
  let stubWebServer: ReturnType<typeof createStubWebServer>
  let stubUsers: ReturnType<typeof createStubPlatformUsers>

  beforeEach(() => {
    ctx = new Context()
    stubWebServer = createStubWebServer()
    stubUsers = createStubPlatformUsers()
    ctx.provide('webServer', stubWebServer as unknown as import('@deepseek-ai/dsh-host-webserver').WebServer)
    ctx.provide('platformUsers', stubUsers as unknown as import('@deepseek-ai/dsh-platform-user').PlatformUserService)
  })

  it('注册 /api/enterprise/auth 前缀路由', () => {
    apply(ctx, TEST_CONFIG)
    expect(stubWebServer.routes).toHaveLength(1)
    expect(stubWebServer.routes[0]!.kind).toBe('prefix')
    expect(stubWebServer.routes[0]!.path).toBe('/api/enterprise/auth')
  })

  it('GET /me 通过 Bearer token 获取当前用户', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    const req = mockReq('GET', '/api/enterprise/auth/me', {
      authorization: 'Bearer valid-token',
    })
    await handler(req, res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body)
    expect(parsed.loginName).toBe('alice')
    expect(parsed.status).toBe('active')
  })

  it('GET /me 成功后发出 platform-user/verified 事件', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const verified: PlatformUser[] = []
    ctx.on('platform-user/verified', (user) => { verified.push(user) })
    const { res } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/me', {
      authorization: 'Bearer valid-token',
    }), res)
    expect(verified).toHaveLength(1)
    expect(verified[0]!.authSubject).toBe('auth-1')
  })

  it('GET /me 失败时不发出 verified 事件', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const verified: PlatformUser[] = []
    ctx.on('platform-user/verified', (user) => { verified.push(user) })
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/me', {
      authorization: 'Bearer bogus-token',
    }), res)
    expect(state.statusCode).toBe(401)
    expect(verified).toEqual([])
  })

  it('POST /signout 返回 204 并发出 platform-user/signout 事件', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    let signouts = 0
    ctx.on('platform-user/signout', () => { signouts += 1 })
    const { res, state } = mockRes()
    await handler(mockReq('POST', '/api/enterprise/auth/signout'), res)
    expect(state.statusCode).toBe(204)
    expect(state.body).toBe('')
    expect(signouts).toBe(1)
  })

  it('GET /signout 方法不匹配返回 404', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/signout'), res)
    expect(state.statusCode).toBe(404)
  })

  it('GET /me 缺少 Authorization 头返回 401', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/me'), res)
    expect(state.statusCode).toBe(401)
  })

  it('GET /me 无效 token 返回 401', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    const req = mockReq('GET', '/api/enterprise/auth/me', {
      authorization: 'Bearer bogus-token',
    })
    await handler(req, res)
    expect(state.statusCode).toBe(401)
  })

  it('GET /config 返回 Supabase 连接信息', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/config'), res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body)
    expect(parsed.url).toBe('https://example.supabase.co')
    expect(parsed.anonKey).toBe('anon-secret')
  })

  it('未匹配的路由返回 404', async () => {
    apply(ctx, TEST_CONFIG)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('DELETE', '/api/enterprise/auth/unknown'), res)
    expect(state.statusCode).toBe(404)
  })
})
