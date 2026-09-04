/**
 * HTTP proxy from the DSH local webserver to the flowable-engine REST API.
 *
 * | DSH route (prefix) | Upstream                        |
 * |--------------------|---------------------------------|
 * | /dsh/tasks         | {engineBaseUrl}/dsh/tasks/...   |
 * | /dsh/history       | {engineBaseUrl}/dsh/history/... |
 *
 * The enterprise deployment topology (v5) requires browser surfaces to reach
 * server-side services only through the local DSH webserver, never directly.
 * The employee task workbench (ui-enterprise) fetches `/dsh/tasks/*` relative
 * to the webserver origin; without this proxy those requests fall through to
 * the SPA fallback and return HTML. The engine serves the same absolute paths
 * under its `/dsh` namespace (context-path `/`), so the proxy forwards
 * pathname and query verbatim, whitelists the authorization and content-type
 * request headers, and answers upstream connectivity failures with a JSON
 * 502 so clients never parse an HTML error page.
 *
 * @module @deepseek-ai/dsh-flowable-task-proxy
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'flowable-task-proxy'

/** 等待 webServer 服务就绪后才挂载路由。 */
export const inject = ['webServer'] as const

/** 插件配置:flowable-engine 的基地址。 */
export interface Config {
  /** flowable-engine 基地址(协议+主机+端口,无路径)。 */
  engineBaseUrl: string
}

export const Config: z<Config> = z.object({
  engineBaseUrl: z.string(),
})

/** 代理的引擎 API 前缀,与引擎 `/dsh` 命名空间的控制器路径一一对应。 */
const PROXIED_PREFIXES = ['/dsh/tasks', '/dsh/history'] as const

/** 转发到引擎的请求头白名单(其余请求头不跨进程边界透传)。 */
const FORWARDED_REQUEST_HEADERS = ['authorization', 'content-type'] as const

/** JSON 响应辅助函数。 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}

/**
 * 读取并缓冲整个请求体。任务提交的 JSON 体很小,缓冲后整体转发。
 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Uint8Array))
  }
  return Buffer.concat(chunks)
}

/**
 * 把请求转发到引擎,并把上游响应(状态码 + 体)原样写回客户端。
 */
async function proxyRequest(
  engineBaseUrl: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
  requests; the field is only optional on the client-side IncomingMessage type */
  const incoming = new URL(req.url ?? '/', 'http://localhost')
  const target = new URL(`${incoming.pathname}${incoming.search}`, engineBaseUrl)
  const headers: Record<string, string> = {}
  for (const header of FORWARDED_REQUEST_HEADERS) {
    // authorization/content-type are declared `string | undefined` on
    // IncomingHttpHeaders — the array form never occurs for them.
    const value = req.headers[header]
    if (typeof value === 'string') {
      headers[header] = value
    }
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  let upstream: Response
  try {
    /* v8 ignore next -- node:http always sets method on server requests. */
    upstream = await fetch(target, {
      method: req.method ?? 'GET',
      headers,
      // Copy into a plain Uint8Array: Buffer<ArrayBufferLike> is not assignable
      // to the DOM BodyInit's ArrayBuffer-backed view union.
      body: hasBody ? new Uint8Array(await readBody(req)) : null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendJson(res, 502, { error: `flowable-engine unreachable at ${engineBaseUrl}: ${message}` })
    return
  }
  const contentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8'
  const body = Buffer.from(await upstream.arrayBuffer())
  res.writeHead(upstream.status, { 'content-type': contentType, 'content-length': body.length })
  res.end(body)
}

/**
 * 注册 `/dsh` 命名空间前缀路由,把员工端任务 API 代理到 flowable-engine。
 *
 * <p>engineBaseUrl 在注册前解析一次,格式非法立即失败(misconfiguration fails
 * loud),否则会表现为每条请求一个难排查的 502。
 *
 * @param ctx - 携带 `webServer` 的 Cordis 上下文。
 * @param config - 插件配置,提供 engineBaseUrl。
 */
export function apply(ctx: Context, config: Config): void {
  const engineBaseUrl = config.engineBaseUrl.replace(/\/+$/, '')
  new URL(engineBaseUrl)
  for (const prefix of PROXIED_PREFIXES) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: prefix,
          handler: (req, res) => proxyRequest(engineBaseUrl, req, res),
        }),
      `flowable-task-proxy: ${prefix} prefix route`,
    )
  }
}
