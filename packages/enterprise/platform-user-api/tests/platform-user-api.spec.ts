import { Context } from '@deepseek-ai/cordis'
import { describe, it, expect, beforeEach } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-platform-user'
import type { AuditEvent, PlatformUser, PlatformUserId } from '@deepseek-ai/dsh-platform-user'

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

/** 最小 PlatformUsers 桩。 */
function createStubPlatformUsers() {
  const users: PlatformUser[] = []
  const auditEvents: AuditEvent[] = []
  let nextId = 1
  let nextTokenId = 1
  const tokenToUserId = new Map<string, string>()
  const stub = {
    async registerPendingUser(req: { authSubject: string; loginName: string; displayName: string; email: string }) {
      const user: PlatformUser = {
        id: `u${nextId++}` as PlatformUserId,
        authSubject: req.authSubject,
        loginName: req.loginName,
        displayName: req.displayName,
        email: req.email,
        status: 'pending_approval',
        platformRoles: [],
        createdAt: new Date().toISOString(),
      }
      users.push(user)
      auditEvents.push({
        id: `a${auditEvents.length + 1}`,
        eventType: 'register_pending',
        targetUserId: user.id,
        operatorId: null,
        details: {},
        createdAt: new Date().toISOString(),
      })
      return user
    },
    async getById(id: PlatformUserId) {
      return users.find(u => u.id === id)
    },
    async getByAuthSubject(s: string) {
      return users.find(u => u.authSubject === s)
    },
    async list() {
      return users
    },
    async approve(id: PlatformUserId, req: { approvedBy: PlatformUserId; platformRoles: readonly string[] }) {
      const u = users.find(u => u.id === id)!
      u.status = 'active'
      u.platformRoles = req.platformRoles as PlatformUser['platformRoles']
      u.approvedAt = new Date().toISOString()
      u.approvedBy = req.approvedBy
      return u
    },
    async setRoles(id: PlatformUserId, req: { platformRoles: readonly string[] }) {
      const u = users.find(u => u.id === id)!
      u.platformRoles = req.platformRoles as PlatformUser['platformRoles']
      return u
    },
    async disable(id: PlatformUserId, req: { disabledBy: PlatformUserId }) {
      const u = users.find(u => u.id === id)!
      u.status = 'disabled'
      u.disabledAt = new Date().toISOString()
      u.disabledBy = req.disabledBy
      return u
    },
    async lock(id: PlatformUserId, req: { lockedBy: PlatformUserId }) {
      const u = users.find(u => u.id === id)!
      u.status = 'locked'
      u.lockedAt = new Date().toISOString()
      u.lockedBy = req.lockedBy
      return u
    },
    async restore(id: PlatformUserId, _req: { restoredBy: PlatformUserId }) {
      const u = users.find(u => u.id === id)!
      u.status = 'active'
      return u
    },
    async signUp(email: string, _password: string, loginName: string, displayName: string) {
      const authSubject = `auth-${nextId}`
      return await stub.registerPendingUser({ authSubject, loginName, displayName, email })
    },
    async signIn(email: string, _password: string) {
      const platformUser = users.find(u => u.email === email)
      if (platformUser === undefined) throw new Error('user not found')
      const accessToken = `token-${nextTokenId++}`
      tokenToUserId.set(accessToken, platformUser.authSubject)
      return { accessToken, platformUser }
    },
    async getUserByToken(accessToken: string) {
      const authSubject = tokenToUserId.get(accessToken)
      if (authSubject === undefined) throw new Error('invalid token')
      const platformUser = users.find(u => u.authSubject === authSubject)
      if (platformUser === undefined) throw new Error('user not found')
      return platformUser
    },
    async listAuditEvents(limit?: number) {
      const reversed = [...auditEvents].reverse()
      return limit !== undefined ? reversed.slice(0, limit) : reversed
    },
  }
  return stub
}

/** 模拟 IncomingMessage。 */
function mockReq(method: string, url: string, body?: unknown): IncomingMessage {
  const bodyStr = body ? JSON.stringify(body) : ''
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      if (bodyStr) yield Buffer.from(bodyStr)
    },
  } as unknown as IncomingMessage
}

/** 模拟 ServerResponse，通过对象引用读取 statusCode 和 body。 */
function mockRes() {
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(status: number) { state.statusCode = status },
    end(data?: string) { state.body = data ?? '' },
  } as unknown as ServerResponse
  return { res, state }
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

  it('注册前缀路由 /api/enterprise/platform-users, /api/enterprise/auth, /api/enterprise/audit-events', () => {
    apply(ctx)
    expect(stubWebServer.routes).toHaveLength(3)
    expect(stubWebServer.routes[0]!.kind).toBe('prefix')
    expect(stubWebServer.routes[0]!.path).toBe('/api/enterprise/platform-users')
    expect(stubWebServer.routes[1]!.path).toBe('/api/enterprise/auth')
    expect(stubWebServer.routes[2]!.path).toBe('/api/enterprise/audit-events')
  })

  it('GET / 列出用户', async () => {
    await stubUsers.registerPendingUser({ authSubject: 'sub1', loginName: 'alice', displayName: 'Alice', email: 'a@x.com' })
    apply(ctx)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/platform-users'), res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].loginName).toBe('alice')
  })

  it('POST /register 注册新用户', async () => {
    apply(ctx)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(
      mockReq('POST', '/api/enterprise/platform-users/register', {
        authSubject: 'sub2', loginName: 'bob', displayName: 'Bob', email: 'b@x.com',
      }),
      res,
    )
    expect(state.statusCode).toBe(201)
    const parsed = JSON.parse(state.body)
    expect(parsed.loginName).toBe('bob')
    expect(parsed.status).toBe('pending_approval')
  })

  it('POST /:id/approve 审批用户', async () => {
    const user = await stubUsers.registerPendingUser({ authSubject: 'sub3', loginName: 'carol', displayName: 'Carol', email: 'c@x.com' })
    apply(ctx)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(
      mockReq('POST', `/api/enterprise/platform-users/${user.id}/approve`, {
        approvedBy: 'admin1', platformRoles: ['normal_user'],
      }),
      res,
    )
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body)
    expect(parsed.status).toBe('active')
    expect(parsed.platformRoles).toEqual(['normal_user'])
  })

  it('POST /:id/disable 禁用用户', async () => {
    const user = await stubUsers.registerPendingUser({ authSubject: 'sub4', loginName: 'dave', displayName: 'Dave', email: 'd@x.com' })
    apply(ctx)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(
      mockReq('POST', `/api/enterprise/platform-users/${user.id}/disable`, {
        disabledBy: 'admin1',
      }),
      res,
    )
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body)
    expect(parsed.status).toBe('disabled')
  })

  it('PUT /:id/roles 更新角色', async () => {
    const user = await stubUsers.registerPendingUser({ authSubject: 'sub5', loginName: 'eve', displayName: 'Eve', email: 'e@x.com' })
    apply(ctx)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(
      mockReq('PUT', `/api/enterprise/platform-users/${user.id}/roles`, {
        changedBy: 'admin1', platformRoles: ['app_admin'],
      }),
      res,
    )
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body)
    expect(parsed.platformRoles).toEqual(['app_admin'])
  })

  it('GET /:id 获取不存在的用户返回 404', async () => {
    apply(ctx)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/platform-users/nonexistent'), res)
    expect(state.statusCode).toBe(404)
  })

  it('POST /register 缺少字段返回 400', async () => {
    apply(ctx)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('POST', '/api/enterprise/platform-users/register', { authSubject: 'x' }), res)
    expect(state.statusCode).toBe(400)
  })

  it('未匹配的路由返回 404', async () => {
    apply(ctx)
    const handler = stubWebServer.routes[0]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('DELETE', '/api/enterprise/platform-users/123'), res)
    expect(state.statusCode).toBe(404)
  })

  it('POST /api/enterprise/auth/register 注册新用户', async () => {
    apply(ctx)
    const handler = stubWebServer.routes[1]!.handler
    const { res, state } = mockRes()
    await handler(
      mockReq('POST', '/api/enterprise/auth/register', {
        email: 'bob@x.com', password: 'pw', loginName: 'bob', displayName: 'Bob',
      }),
      res,
    )
    expect(state.statusCode).toBe(201)
    const parsed = JSON.parse(state.body)
    expect(parsed.loginName).toBe('bob')
    expect(parsed.status).toBe('pending_approval')
  })

  it('POST /api/enterprise/auth/register 缺少字段返回 400', async () => {
    apply(ctx)
    const handler = stubWebServer.routes[1]!.handler
    const { res, state } = mockRes()
    await handler(
      mockReq('POST', '/api/enterprise/auth/register', { email: 'x' }),
      res,
    )
    expect(state.statusCode).toBe(400)
  })

  it('POST /api/enterprise/auth/login 登录并返回 token', async () => {
    await stubUsers.signUp('alice@x.com', 'pw', 'alice', 'Alice')
    apply(ctx)
    const handler = stubWebServer.routes[1]!.handler
    const { res, state } = mockRes()
    await handler(
      mockReq('POST', '/api/enterprise/auth/login', {
        email: 'alice@x.com', password: 'pw',
      }),
      res,
    )
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body)
    expect(parsed.accessToken.length).toBeGreaterThan(0)
    expect(parsed.platformUser.loginName).toBe('alice')
  })

  it('GET /api/enterprise/auth/me 通过 Bearer token 获取当前用户', async () => {
    await stubUsers.signUp('alice@x.com', 'pw', 'alice', 'Alice')
    const result = await stubUsers.signIn('alice@x.com', 'pw')
    apply(ctx)
    const handler = stubWebServer.routes[1]!.handler
    const { res, state } = mockRes()
    const req = mockReq('GET', '/api/enterprise/auth/me')
    req.headers.authorization = `Bearer ${result.accessToken}`
    await handler(req, res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body)
    expect(parsed.loginName).toBe('alice')
  })

  it('GET /api/enterprise/auth/me 缺少 Authorization 头返回 401', async () => {
    apply(ctx)
    const handler = stubWebServer.routes[1]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/auth/me'), res)
    expect(state.statusCode).toBe(401)
  })

  it('GET /api/enterprise/audit-events 列出审计事件', async () => {
    await stubUsers.signUp('bob@x.com', 'pw', 'bob', 'Bob')
    apply(ctx)
    const handler = stubWebServer.routes[2]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/audit-events'), res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].eventType).toBe('register_pending')
  })

  it('GET /api/enterprise/audit-events?limit=1 限制返回数量', async () => {
    await stubUsers.signUp('bob@x.com', 'pw', 'bob', 'Bob')
    await stubUsers.signUp('carol@x.com', 'pw', 'carol', 'Carol')
    apply(ctx)
    const handler = stubWebServer.routes[2]!.handler
    const { res, state } = mockRes()
    await handler(mockReq('GET', '/api/enterprise/audit-events?limit=1'), res)
    expect(state.statusCode).toBe(200)
    const parsed = JSON.parse(state.body)
    expect(parsed).toHaveLength(1)
  })
})
