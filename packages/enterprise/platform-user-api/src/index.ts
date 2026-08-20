/**
 * HTTP API routes for platform-user governance and authentication.
 *
 * Registers prefix routes and dispatches by path segment and HTTP method:
 *
 * | Method | Path                                    | Operation  |
 * |--------|-----------------------------------------|------------|
 * | GET    | /api/enterprise/platform-users          | list       |
 * | GET    | /api/enterprise/platform-users/:id      | get one    |
 * | POST   | /api/enterprise/platform-users/register| register   |
 * | POST   | /api/enterprise/platform-users/:id/approve   | approve  |
 * | POST   | /api/enterprise/platform-users/:id/disable   | disable  |
 * | POST   | /api/enterprise/platform-users/:id/lock       | lock     |
 * | POST   | /api/enterprise/platform-users/:id/restore    | restore  |
 * | PUT    | /api/enterprise/platform-users/:id/roles      | setRoles |
 * | POST   | /api/enterprise/auth/register          | sign up   |
 * | POST   | /api/enterprise/auth/login              | sign in   |
 * | GET    | /api/enterprise/auth/me                 | current user |
 * | GET    | /api/enterprise/audit-events            | list audit |
 *
 * @module @deepseek-ai/dsh-platform-user-api
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-platform-user'
import {
  PlatformUserError,
  type AuditEvent,
  type PlatformRole,
  type PlatformUser,
  type PlatformUserId,
  type PlatformUserStatus,
} from '@deepseek-ai/dsh-platform-user'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'platform-user-api'

/** 等待 webServer 和 platformUsers 服务就绪后才挂载路由。 */
export const inject = ['webServer', 'platformUsers'] as const

/** 前缀路由路径，比内置 `/api` 更长，优先匹配。 */
const ROUTE_PREFIX = '/api/enterprise/platform-users'

/** JSON 响应辅助函数。 */
function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}

/** 读取请求体并解析 JSON。 */
async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (raw.length === 0) return {}
  return JSON.parse(raw)
}

/** 将 PlatformUserError 映射为 HTTP 状态码。 */
function errorCodeToStatus(code: string): number {
  switch (code) {
    case 'NO_PROVIDER':
    case 'DUPLICATE_PROVIDER':
      return 500
    case 'NOT_FOUND':
    case 'UNKNOWN_USER':
      return 404
    case 'ALREADY_ACTIVE':
    case 'ALREADY_DISABLED':
    case 'ALREADY_LOCKED':
    case 'ALREADY_PENDING':
    case 'INVALID_STATUS_TRANSITION':
      return 409
    case 'AUTH_SIGNIN_FAILED':
    case 'AUTH_TOKEN_INVALID':
      return 401
    case 'AUTH_SIGNUP_FAILED':
    case 'INVALID_ROLE':
    case 'DUPLICATE_ROLE':
    case 'INVALID_STATUS':
      return 400
    default:
      return 500
  }
}

/** 统一错误处理。 */
function handleError(res: import('node:http').ServerResponse, error: unknown): void {
  if (error instanceof PlatformUserError) {
    sendJson(res, errorCodeToStatus(error.code), { error: error.message, code: error.code })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, 400, { error: message })
}

/** 阻止当前登录用户对自己执行危险治理操作。 */
function ensureNotSelf(res: import('node:http').ServerResponse, actorId: string, targetId: string): boolean {
  if (actorId !== targetId) return true
  sendJson(res, 400, { error: 'cannot operate on current user' })
  return false
}

/** 只有系统管理员可以执行平台治理动作。 */
async function ensureSystemAdmin(
  ctx: Context,
  res: import('node:http').ServerResponse,
  actorId: string,
): Promise<boolean> {
  const actor = await ctx.platformUsers.getById(actorId as PlatformUserId)
  if (actor !== undefined && actor.platformRoles.includes('system_admin')) return true
  sendJson(res, 403, { error: 'system_admin role is required' })
  return false
}

/** 将 PlatformUser 序列化为 JSON 响应对象。 */
function serializeUser(user: PlatformUser): Record<string, unknown> {
  return {
    id: user.id,
    authSubject: user.authSubject,
    loginName: user.loginName,
    displayName: user.displayName,
    email: user.email,
    status: user.status,
    platformRoles: user.platformRoles,
    createdAt: user.createdAt,
    createdBy: user.createdBy,
    approvedAt: user.approvedAt,
    approvedBy: user.approvedBy,
    disabledAt: user.disabledAt,
    disabledBy: user.disabledBy,
    disabledReason: user.disabledReason,
    lockedAt: user.lockedAt,
    lockedBy: user.lockedBy,
    lockedReason: user.lockedReason,
  }
}

/** 将 AuditEvent 序列化为 JSON 响应对象。 */
function serializeAuditEvent(event: AuditEvent): Record<string, unknown> {
  return {
    id: event.id,
    eventType: event.eventType,
    targetUserId: event.targetUserId,
    operatorId: event.operatorId,
    details: event.details,
    createdAt: event.createdAt,
  }
}

/** 校验字符串数组，返回 null 表示通过。 */
function validateStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((v): v is string => typeof v === 'string')
}

/** 校验角色数组。 */
function validateRoles(value: unknown): readonly PlatformRole[] | null {
  const arr = validateStringArray(value)
  if (arr === null) return null
  const valid: PlatformRole[] = []
  for (const role of arr) {
    if (role !== 'system_admin' && role !== 'app_admin' && role !== 'normal_user') return null
    valid.push(role)
  }
  return valid
}

/**
 * 解析前缀后的路径段，返回剩余段数组。
 */
function parseSegments(urlPath: string, prefix: string): readonly string[] {
  const stripped = urlPath.slice(prefix.length)
  const trimmed = stripped.replace(/^\/+|\/+$/g, '')
  if (trimmed.length === 0) return []
  return trimmed.split('/')
}

/**
 * 路由分发：根据 method + segments 调用对应的服务方法。
 */
async function dispatch(
  ctx: Context,
  method: string,
  segments: readonly string[],
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  // GET /api/enterprise/platform-users - 列出用户
  if (method === 'GET' && segments.length === 0) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const statusParam = url.searchParams.get('status')
    const roleParam = url.searchParams.get('role')
    const statuses = statusParam?.split(',').filter(Boolean) as readonly PlatformUserStatus[] | undefined
    const users = await ctx.platformUsers.list({
      ...(statuses && statuses.length > 0 ? { statuses } : {}),
      ...(roleParam ? { role: roleParam as PlatformRole } : {}),
    })
    sendJson(res, 200, users.map(serializeUser))
    return
  }

  // GET /api/enterprise/platform-users/:id - 获取单个用户
  if (method === 'GET' && segments.length === 1) {
    const user = await ctx.platformUsers.getById(segments[0] as PlatformUserId)
    if (user === undefined) {
      sendJson(res, 404, { error: 'user not found' })
      return
    }
    sendJson(res, 200, serializeUser(user))
    return
  }

  // POST /api/enterprise/platform-users/register - 注册新用户
  if (method === 'POST' && segments.length === 1 && segments[0] === 'register') {
    const body = await readJsonBody(req) as Record<string, unknown>
    const authSubject = body.authSubject
    const loginName = body.loginName
    const displayName = body.displayName
    const email = body.email
    if (typeof authSubject !== 'string' || typeof loginName !== 'string'
      || typeof displayName !== 'string' || typeof email !== 'string') {
      sendJson(res, 400, { error: 'authSubject, loginName, displayName, email are required strings' })
      return
    }
    const user = await ctx.platformUsers.registerPendingUser({
      authSubject, loginName, displayName, email,
    })
    sendJson(res, 201, serializeUser(user))
    return
  }

  // POST /api/enterprise/platform-users/:id/approve - 审批通过
  if (method === 'POST' && segments.length === 2 && segments[1] === 'approve') {
    const body = await readJsonBody(req) as Record<string, unknown>
    const approvedBy = body.approvedBy
    const roles = validateRoles(body.platformRoles)
    if (typeof approvedBy !== 'string' || roles === null) {
      sendJson(res, 400, { error: 'approvedBy (string) and platformRoles (string array) are required' })
      return
    }
    if (!await ensureSystemAdmin(ctx, res, approvedBy)) return
    const user = await ctx.platformUsers.approve(segments[0] as PlatformUserId, {
      approvedBy: approvedBy as PlatformUserId,
      platformRoles: roles,
    })
    sendJson(res, 200, serializeUser(user))
    return
  }

  // POST /api/enterprise/platform-users/:id/disable - 禁用
  if (method === 'POST' && segments.length === 2 && segments[1] === 'disable') {
    const targetId = segments[0]
    if (targetId === undefined) {
      sendJson(res, 404, { error: 'user not found' })
      return
    }
    const body = await readJsonBody(req) as Record<string, unknown>
    const disabledBy = body.disabledBy
    if (typeof disabledBy !== 'string') {
      sendJson(res, 400, { error: 'disabledBy (string) is required' })
      return
    }
    if (!await ensureSystemAdmin(ctx, res, disabledBy)) return
    if (!ensureNotSelf(res, disabledBy, targetId)) return
    const reason = typeof body.reason === 'string' ? body.reason : undefined
    const user = await ctx.platformUsers.disable(targetId as PlatformUserId, {
      disabledBy: disabledBy as PlatformUserId,
      ...(reason !== undefined ? { reason } : {}),
    })
    sendJson(res, 200, serializeUser(user))
    return
  }

  // POST /api/enterprise/platform-users/:id/lock - 锁定
  if (method === 'POST' && segments.length === 2 && segments[1] === 'lock') {
    const targetId = segments[0]
    if (targetId === undefined) {
      sendJson(res, 404, { error: 'user not found' })
      return
    }
    const body = await readJsonBody(req) as Record<string, unknown>
    const lockedBy = body.lockedBy
    if (typeof lockedBy !== 'string') {
      sendJson(res, 400, { error: 'lockedBy (string) is required' })
      return
    }
    if (!await ensureSystemAdmin(ctx, res, lockedBy)) return
    if (!ensureNotSelf(res, lockedBy, targetId)) return
    const reason = typeof body.reason === 'string' ? body.reason : undefined
    const user = await ctx.platformUsers.lock(targetId as PlatformUserId, {
      lockedBy: lockedBy as PlatformUserId,
      ...(reason !== undefined ? { reason } : {}),
    })
    sendJson(res, 200, serializeUser(user))
    return
  }

  // POST /api/enterprise/platform-users/:id/restore - 恢复
  if (method === 'POST' && segments.length === 2 && segments[1] === 'restore') {
    const body = await readJsonBody(req) as Record<string, unknown>
    const restoredBy = body.restoredBy
    if (typeof restoredBy !== 'string') {
      sendJson(res, 400, { error: 'restoredBy (string) is required' })
      return
    }
    const user = await ctx.platformUsers.restore(segments[0] as PlatformUserId, {
      restoredBy: restoredBy as PlatformUserId,
    })
    sendJson(res, 200, serializeUser(user))
    return
  }

  // PUT /api/enterprise/platform-users/:id/roles - 更新角色
  if (method === 'PUT' && segments.length === 2 && segments[1] === 'roles') {
    const targetId = segments[0]
    if (targetId === undefined) {
      sendJson(res, 404, { error: 'user not found' })
      return
    }
    const body = await readJsonBody(req) as Record<string, unknown>
    const changedBy = body.changedBy
    const roles = validateRoles(body.platformRoles)
    if (typeof changedBy !== 'string' || roles === null) {
      sendJson(res, 400, { error: 'changedBy (string) and platformRoles (string array) are required' })
      return
    }
    if (!await ensureSystemAdmin(ctx, res, changedBy)) return
    if (!ensureNotSelf(res, changedBy, targetId)) return
    const user = await ctx.platformUsers.setRoles(targetId as PlatformUserId, {
      changedBy: changedBy as PlatformUserId,
      platformRoles: roles,
    })
    sendJson(res, 200, serializeUser(user))
    return
  }

  sendJson(res, 404, { error: `no route for ${method} ${ROUTE_PREFIX}/${segments.join('/')}` })
}

/** 认证路由前缀。 */
const AUTH_ROUTE_PREFIX = '/api/enterprise/auth'

/** 审计事件路由前缀。 */
const AUDIT_ROUTE_PREFIX = '/api/enterprise/audit-events'

/**
 * 认证路由分发：根据 method + segments 调用对应的服务方法。
 */
async function dispatchAuth(
  ctx: Context,
  method: string,
  segments: readonly string[],
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  // POST /api/enterprise/auth/register - 注册
  if (method === 'POST' && segments.length === 1 && segments[0] === 'register') {
    const body = await readJsonBody(req) as Record<string, unknown>
    const email = body.email
    const password = body.password
    const loginName = body.loginName
    const displayName = body.displayName
    if (typeof email !== 'string' || typeof password !== 'string'
      || typeof loginName !== 'string' || typeof displayName !== 'string') {
      sendJson(res, 400, { error: 'email, password, loginName, displayName are required strings' })
      return
    }
    const user = await ctx.platformUsers.signUp(email, password, loginName, displayName)
    sendJson(res, 201, serializeUser(user))
    return
  }

  // POST /api/enterprise/auth/login - 登录
  if (method === 'POST' && segments.length === 1 && segments[0] === 'login') {
    const body = await readJsonBody(req) as Record<string, unknown>
    const email = body.email
    const password = body.password
    if (typeof email !== 'string' || typeof password !== 'string') {
      sendJson(res, 400, { error: 'email (string) and password (string) are required' })
      return
    }
    const result = await ctx.platformUsers.signIn(email, password)
    sendJson(res, 200, {
      accessToken: result.accessToken,
      platformUser: serializeUser(result.platformUser),
    })
    return
  }

  // GET /api/enterprise/auth/me - 获取当前用户
  if (method === 'GET' && segments.length === 1 && segments[0] === 'me') {
    const authHeader = req.headers.authorization
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      sendJson(res, 401, { error: 'Authorization: Bearer <token> header is required' })
      return
    }
    const accessToken = authHeader.slice('Bearer '.length)
    const user = await ctx.platformUsers.getUserByToken(accessToken)
    sendJson(res, 200, serializeUser(user))
    return
  }

  sendJson(res, 404, { error: `no route for ${method} ${AUTH_ROUTE_PREFIX}/${segments.join('/')}` })
}

/**
 * 审计事件路由分发。
 */
async function dispatchAudit(
  ctx: Context,
  method: string,
  segments: readonly string[],
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  // GET /api/enterprise/audit-events - 列出审计事件
  if (method === 'GET' && segments.length === 0) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const limitParam = url.searchParams.get('limit')
    const limit = limitParam !== null ? Number.parseInt(limitParam, 10) : undefined
    if (limit !== undefined && Number.isNaN(limit)) {
      sendJson(res, 400, { error: 'limit must be a number' })
      return
    }
    const events = await ctx.platformUsers.listAuditEvents(limit)
    sendJson(res, 200, events.map(serializeAuditEvent))
    return
  }

  sendJson(res, 404, { error: `no route for ${method} ${AUDIT_ROUTE_PREFIX}/${segments.join('/')}` })
}

/**
 * 注册平台用户治理的 HTTP API 路由。
 * @param ctx - 携带 `webServer` 和 `platformUsers` 的 Cordis 上下文。
 */
export function apply(ctx: Context): void {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname
        const segments = parseSegments(urlPath, ROUTE_PREFIX)
        try {
          await dispatch(ctx, req.method ?? 'GET', segments, req, res)
        } catch (error) {
          handleError(res, error)
        }
      },
    }),
  'platform-user-api: /api/enterprise/platform-users prefix route',
  )
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: AUTH_ROUTE_PREFIX,
      handler: async (req, res) => {
        const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname
        const segments = parseSegments(urlPath, AUTH_ROUTE_PREFIX)
        try {
          await dispatchAuth(ctx, req.method ?? 'GET', segments, req, res)
        } catch (error) {
          handleError(res, error)
        }
      },
    }),
  'platform-user-api: /api/enterprise/auth prefix route',
  )
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: AUDIT_ROUTE_PREFIX,
      handler: async (req, res) => {
        const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname
        const segments = parseSegments(urlPath, AUDIT_ROUTE_PREFIX)
        try {
          await dispatchAudit(ctx, req.method ?? 'GET', segments, req, res)
        } catch (error) {
          handleError(res, error)
        }
      },
    }),
  'platform-user-api: /api/enterprise/audit-events prefix route',
  )
}
