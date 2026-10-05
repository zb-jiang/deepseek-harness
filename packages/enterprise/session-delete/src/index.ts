/**
 * HTTP endpoint that permanently deletes one archived session.
 *
 * | Method | Path                            | Operation                   |
 * |--------|---------------------------------|-----------------------------|
 * | POST   | /api/enterprise/sessions/delete | delete one archived session |
 *
 * The request body is `{ "sessionId": "<id>" }`. Only archived sessions are
 * deletable: archive membership is the guarantee that no live write can still
 * touch the artifact (the archive gate blocks every `agent/pre-step` wake, and
 * an unforced archive refuses active sessions). Deletion removes the session's
 * JSONL artifact directory, drops the id from every workspace's accounted
 * list, and drops it from the registry-global archive set. Deletion
 * converges: when the JSONL snapshot is absent (artifact already deleted
 * externally) or the artifact directory is missing, the call skips the
 * directory removal and clears the bookkeeping directly.
 *
 * @module @deepseek-ai/dsh-session-delete
 */

import { rm, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import { sessionDir } from '@deepseek-ai/dsh-session-persistence-jsonl'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'session-delete'

/** 等待 webServer、sessionPersistence、workspaceRegistry 就绪后才挂载路由。 */
export const inject = ['webServer', 'sessionPersistence', 'workspaceRegistry']

/** 删除路由路径。 */
const DELETE_ROUTE = '/api/enterprise/sessions/delete'

/** 携带 HTTP 状态码的删除失败；handler 统一映射为 JSON 错误响应。 */
class SessionDeleteHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'SessionDeleteHttpError'
  }
}

/**
 * 读取请求体的 JSON；空体、非法 JSON 或超过 64KB 的请求返回 undefined。
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
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
    // 请求体不是合法 JSON：按缺失处理，由调用方拒绝。
    return undefined
  }
}

/** 从请求体提取非空字符串 sessionId；缺失或类型不符返回 undefined。 */
function readSessionId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('sessionId' in body)) return undefined
  const sessionId: unknown = body.sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

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
 * 目录是否存在；stat 失败（ENOENT 或不可读）一律按不存在处理。
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    // stat 失败 = 路径不可达，删除语义下与不存在等价。
    return false
  }
}

/**
 * 从实际挂载的持久化后端实例探测 JSONL 根目录。root 的唯一事实来源是
 * persistence 插件自己的配置（base patch 的 `dshHomePath('sessions')`），
 * 这里只做结构探测，不复制配置；非 JSONL 后端不支持删除，报错拒绝。
 */
function persistenceRoot(persistence: SessionPersistence): string {
  if (!('config' in persistence)) {
    throw new SessionDeleteHttpError(
      500,
      'session persistence backend does not expose its configuration; only the JSONL backend supports deletion',
    )
  }
  const config: unknown = persistence.config
  if (typeof config !== 'object' || config === null || !('root' in config)) {
    throw new SessionDeleteHttpError(500, 'session persistence configuration carries no root; only the JSONL backend supports deletion')
  }
  const root: unknown = config.root
  if (typeof root !== 'string' || root.length === 0) {
    throw new SessionDeleteHttpError(500, 'session persistence root is not a non-empty string')
  }
  return root
}

/**
 * 删除一个已归档会话：删 JSONL 工件目录 → 清 workspace 记账 → 移出归档集。
 * 持久化里找不到 snapshot（工件已被外部删除）或目录缺失时跳过目录删除，
 * 直接清记账收敛，归档 id 不会残留。
 */
async function deleteArchivedSession(ctx: Context, rawSessionId: string): Promise<void> {
  const registry = ctx.workspaceRegistry
  const archivedId = registry.archivedSessionIds.find(id => id === rawSessionId)
  if (archivedId === undefined) {
    throw new SessionDeleteHttpError(409, `session '${rawSessionId}' is not archived; only archived sessions can be deleted`)
  }

  const snapshots = await ctx.sessionPersistence.list()
  const snapshot = snapshots.find(entry => entry.header.id === archivedId)
  // snapshot 缺失 = 工件已被外部删除（或上次调用中断），跳过目录删除直接清记账收敛。
  if (snapshot !== undefined) {
    const root = persistenceRoot(ctx.sessionPersistence)
    const dir = resolve(sessionDir(root, snapshot.header.cwd, snapshot.header.id))
    const resolvedRoot = resolve(root)
    if (!dir.startsWith(resolvedRoot + sep)) {
      throw new SessionDeleteHttpError(500, `session directory '${dir}' escaped the persistence root '${resolvedRoot}'`)
    }
    if (await pathExists(dir)) {
      await rm(dir, { recursive: true, force: true })
    }
  }

  for (const workspace of registry.list()) {
    const attachedId = workspace.sessionIds.find(id => id === archivedId)
    if (attachedId !== undefined) await workspace.detachSession(attachedId)
  }
  await registry.unarchiveSession(archivedId)
}

/**
 * 注册已归档会话的永久删除端点。
 * @param ctx - 携带 `webServer`、`sessionPersistence`、`workspaceRegistry` 的 Cordis 上下文。
 */
export function apply(ctx: Context): void {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: DELETE_ROUTE,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: `${req.method ?? 'GET'} is not supported; use POST ${DELETE_ROUTE}` })
            return
          }
          const sessionId = readSessionId(await readJsonBody(req))
          if (sessionId === undefined) {
            sendJson(res, 400, { error: 'request body must be JSON of the form { "sessionId": "<id>" }' })
            return
          }
          await deleteArchivedSession(ctx, sessionId)
          sendJson(res, 200, { deleted: sessionId })
        } catch (error) {
          if (error instanceof SessionDeleteHttpError) {
            sendJson(res, error.status, { error: error.message })
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          sendJson(res, 500, { error: message })
        }
      },
    }),
  'session-delete: /api/enterprise/sessions/delete route',
  )
}
