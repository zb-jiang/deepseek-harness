/**
 * HTTP API routes for platform-user authentication on the DSH side.
 *
 * | Method | Path                       | Operation       |
 * |--------|----------------------------|-----------------|
 * | GET    | /api/enterprise/auth/me    | current user    |
 * | GET    | /api/enterprise/auth/config | Supabase config |
 * | POST   | /api/enterprise/auth/signout | announce signout |
 *
 * Every verified `/me` response emits `platform-user/verified`; the signout
 * touchpoint emits `platform-user/signout`. Identity-cache listeners (e.g.
 * `user-identity-context`) subscribe to these events; this plugin itself
 * holds no state.
 *
 * Governance writes (register, approve, disable, lock, restore, roles,
 * audit) live in the Web Console backend, not here.
 *
 * @module @deepseek-ai/dsh-platform-user-api
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-platform-user'
import {
  PlatformUserError,
  type PlatformUser,
} from '@deepseek-ai/dsh-platform-user'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'platform-user-api'

/** 等待 webServer 和 platformUsers 服务就绪后才挂载路由。 */
export const inject = ['webServer', 'platformUsers']

/** 插件配置：Supabase 连接信息，用于 /auth/config 端点向前端暴露。 */
export interface Config {
  /** Supabase 项目 URL;volatile:设置面板可改,即时生效。 */
  supabaseUrl: Volatile<string>
  /** Supabase anon key，前端直连 Supabase Auth 使用;volatile:设置面板可改,即时生效。 */
  supabaseAnonKey: Volatile<string>
}

export const Config = z.object({
  supabaseUrl: z.string().required().volatile(),
  // 不标 role('secret'):secret 字段经 wire 读取会被永久打码,设置面板的小眼睛
  // 无法回显明文;掩码由面板 UI 层负责(本地 webserver 仅本机可达)。
  supabaseAnonKey: z.string().required().volatile(),
})

/** 认证路由前缀。 */
const AUTH_ROUTE_PREFIX = '/api/enterprise/auth'

/** 连通性探测超时(毫秒):企业内网服务应秒级可达,5s 足够宽容。 */
const PROBE_TIMEOUT_MS = 5000

/** 读取请求体的 JSON(空体/非法 JSON 返回 undefined)。 */
async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
    if (chunks.reduce((sum, c) => sum + c.length, 0) > 64 * 1024) {
      return undefined
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
  } catch {
    return undefined
  }
}

/**
 * Node 侧连通性探测:对目标 URL 发一次 GET,连通(任意 HTTP 状态码)即算可达。
 *
 * <p>必须由 Node 发起而不能在浏览器直接 fetch:引擎/console/SkillHub 的端点
 * 不开 CORS,浏览器探测会把"配置正确"误报为"不可达"。仅接受 http/https。
 */
async function probeConnectivity(rawUrl: string): Promise<{ ok: boolean; status: number; latencyMs: number; error?: string }> {
  const started = Date.now()
  try {
    const response = await fetch(rawUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'follow',
    })
    // 读一小段让连接完成(响应体可能很大,丢弃)
    await response.arrayBuffer()
    return { ok: true, status: response.status, latencyMs: Date.now() - started }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, status: 0, latencyMs: Date.now() - started, error: message }
  }
}

/** JSON 响应辅助函数。 */
function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}

/** 将 PlatformUserError 映射为 HTTP 状态码。 */
function errorCodeToStatus(code: string): number {
  switch (code) {
    case 'NO_PROVIDER':
    case 'DUPLICATE_PROVIDER':
      return 500
    case 'UNKNOWN_USER':
      return 404
    case 'AUTH_TOKEN_INVALID':
      return 401
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
 * 认证路由分发：根据 method + segments 调用对应的服务方法。
 */
async function dispatchAuth(
  ctx: Context,
  config: Config,
  method: string,
  segments: readonly string[],
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  // GET /api/enterprise/auth/me - 获取当前用户
  if (method === 'GET' && segments.length === 1 && segments[0] === 'me') {
    const authHeader = req.headers.authorization
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
      sendJson(res, 401, { error: 'Authorization: Bearer <token> header is required' })
      return
    }
    const accessToken = authHeader.slice('Bearer '.length)
    const user = await ctx.platformUsers.getUserByToken(accessToken)
    // 事件携带原始 token:skill-sync 等企业消费者以当前登录员工身份调用服务端 API
    ctx.emit('platform-user/verified', user, accessToken)
    sendJson(res, 200, serializeUser(user))
    return
  }

  // POST /api/enterprise/auth/signout - 员工登出的身份缓存失效触点
  if (method === 'POST' && segments.length === 1 && segments[0] === 'signout') {
    ctx.emit('platform-user/signout')
    res.writeHead(204)
    res.end()
    return
  }

  // GET /api/enterprise/auth/config - 向前端暴露 Supabase 连接信息
  if (method === 'GET' && segments.length === 1 && segments[0] === 'config') {
    // volatile 配置:每次请求读当前值,设置面板修改后无需重载即生效
    sendJson(res, 200, {
      url: config.supabaseUrl.get(),
      anonKey: config.supabaseAnonKey.get(),
    })
    return
  }

  // POST /api/enterprise/auth/connectivity-check - Node 侧连通性探测(登录页/设置面板共用)
  if (method === 'POST' && segments.length === 1 && segments[0] === 'connectivity-check') {
    const body = await readJsonBody(req)
    const rawUrl = typeof body === 'object' && body !== null && 'url' in body
      ? String(body.url).trim()
      : ''
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      sendJson(res, 400, { error: 'url 缺失或格式无效' })
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      sendJson(res, 400, { error: '仅支持 http/https 地址' })
      return
    }
    sendJson(res, 200, await probeConnectivity(rawUrl))
    return
  }

  sendJson(res, 404, { error: `no route for ${method} ${AUTH_ROUTE_PREFIX}/${segments.join('/')}` })
}

/**
 * 注册平台用户认证的 HTTP API 路由。
 * @param ctx - 携带 `webServer` 和 `platformUsers` 的 Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: AUTH_ROUTE_PREFIX,
      handler: async (req, res) => {
        const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname
        const segments = parseSegments(urlPath, AUTH_ROUTE_PREFIX)
        try {
          await dispatchAuth(ctx, config, req.method ?? 'GET', segments, req, res)
        } catch (error) {
          handleError(res, error)
        }
      },
    }),
  'platform-user-api: /api/enterprise/auth prefix route',
  )
}
