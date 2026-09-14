/**
 * Enterprise knowledge base access on the employee side (design 2026-09-11 §6).
 *
 * Two surfaces over the same web-console REST:
 *
 * 1. Local webserver proxy: browser surfaces (ui-enterprise KB selector,
 *    workspace upload) reach web-console `/api/kb/*` and `/api/apps/*` only
 *    through the local DSH webserver — never directly — with the signed-in
 *    employee's Supabase JWT attached from `ctx.currentUser.getToken()`.
 *
 * 2. Model-facing tools `kb_search` / `kb_read` / `kb_list` registered on
 *    `ctx.tools`, so the todo-session AI can retrieve application knowledge on
 *    demand. Tool calls and results go through the normal registry pipeline,
 *    which logs them as session events (model-visible ⟺ logged).
 *
 * @module @deepseek-ai/dsh-knowledge
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-user-identity-context'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'knowledge'

/** 等待本地 webserver、登录身份存储与工具注册表就绪后才挂载。 */
export const inject = ['webServer', 'currentUser', 'tools'] as const

/** web-console 基地址默认值(企业服务器常驻部署)。 */
const DEFAULT_WEB_CONSOLE_BASE_URL = 'http://127.0.0.1:8080'

/** kb_read 全文返回上限默认值(字符;超出截断并注明)。 */
const DEFAULT_READ_MAX_CHARS = 40_000

/** kb_search 默认返回条数。 */
const DEFAULT_TOP_K = 8

/** 插件配置,全部来自 enterprise profile 的 cordis.yml config 段。 */
export interface Config {
  /** web-console 基地址(协议+主机+端口,无路径)。 */
  webConsoleBaseUrl: string
  /** kb_read 返回全文的最大字符数,超出截断并在结果中注明。 */
  readMaxChars: number
}

export const Config: z<Config> = z.object({
  webConsoleBaseUrl: z.string().default(DEFAULT_WEB_CONSOLE_BASE_URL),
  readMaxChars: z.number().default(DEFAULT_READ_MAX_CHARS),
})

/**
 * 已解析的运行选项(apply 阶段完成校验与默认值合并)。
 *
 * <p>token 取值函数注入而非内联,便于测试桩替换登录态。
 */
export interface KnowledgeOptions {
  /** web-console 基地址(无尾斜杠)。 */
  readonly webConsoleBaseUrl: string
  /** kb_read 全文返回上限(字符)。 */
  readonly readMaxChars: number
  /** 当前登录员工的 Supabase JWT;未登录为 undefined。 */
  readonly token: () => string | undefined
}

/** 代理路由:本地前缀 → web-console 真实前缀(浏览器只经本地 webserver)。 */
const PROXY_ROUTES: ReadonlyArray<{ readonly local: string; readonly upstream: string }> = [
  { local: '/api/enterprise/kb', upstream: '/api/kb' },
  { local: '/api/enterprise/apps', upstream: '/api/apps' },
]

/** web-console {@code ApiResponse} 信封(成功时 data 必有值)。 */
interface ApiEnvelope<T> {
  success?: boolean
  data?: T
  error?: { message?: string }
}

/** web-console {@code KbFolderDto}(本插件只消费 id、name 与 path)。 */
interface KbFolderDto {
  id: string
  name: string
  path: string
}

/** web-console {@code KbDocumentDto}(本插件只消费展示字段)。 */
interface KbDocumentDto {
  id: string
  name: string
  folderId: string | null
  sizeBytes: number
  parseStatus: string
  textExcerpt: string
}

/** web-console {@code KbDocumentTextDto}(kb_read 端点)。 */
interface KbDocumentTextDto {
  id: string
  kbId: string
  name: string
  textContent: string | null
  parseStatus: string
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

/** 读取并缓冲整个请求体(multipart 上传与 JSON 提交都是有限体,整体转发)。 */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Uint8Array))
  }
  return Buffer.concat(chunks)
}

/**
 * 把请求转发到 web-console(附当前登录 JWT),上游响应(状态码 + 体)原样回写。
 *
 * <p>未登录回 401;web-console 不可达回 JSON 502,浏览器侧永远不解析 HTML 错误页。
 *
 * @param options - 运行选项
 * @param localPrefix - 本地路由前缀(webserver 路由保证命中)
 * @param upstreamPrefix - web-console 侧前缀
 * @param req - 浏览器请求
 * @param res - 浏览器响应
 */
async function proxyRequest(
  options: KnowledgeOptions,
  localPrefix: string,
  upstreamPrefix: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
  requests; the field is only optional on the client-side IncomingMessage type */
  const incoming = new URL(req.url ?? '/', 'http://localhost')
  const token = options.token()
  if (token === undefined) {
    sendJson(res, 401, { error: '未登录,无法访问企业知识库' })
    return
  }
  const suffix = incoming.pathname.slice(localPrefix.length)
  const target = new URL(`${upstreamPrefix}${suffix}${incoming.search}`, options.webConsoleBaseUrl)
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  const contentType = req.headers['content-type']
  // content-type is declared `string | undefined` on IncomingHttpHeaders —
  // the array form never occurs for it.
  if (typeof contentType === 'string') {
    headers['content-type'] = contentType
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
    sendJson(res, 502, { error: `web-console 不可达(${options.webConsoleBaseUrl}): ${message}` })
    return
  }
  const responseContentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8'
  const body = Buffer.from(await upstream.arrayBuffer())
  res.writeHead(upstream.status, { 'content-type': responseContentType, 'content-length': body.length })
  res.end(body)
}

/**
 * 调 web-console 知识库 REST 并解 {@code ApiResponse} 信封。
 *
 * @param options - 运行选项
 * @param path - 以 / 开头的绝对路径(不含 base)
 * @returns 信封 data
 * @throws Error 未登录 / 网络不可达 / 响应非 JSON / 信封失败(错误消息面向模型呈现)
 */
async function requestJson<T>(options: KnowledgeOptions, path: string): Promise<T> {
  const token = options.token()
  if (token === undefined) {
    throw new Error('未登录,无法访问企业知识库')
  }
  let resp: Response
  try {
    resp = await fetch(new URL(path, options.webConsoleBaseUrl), {
      headers: { authorization: `Bearer ${token}` },
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
    throw new Error(`web-console 知识库请求失败(HTTP ${resp.status}): ${body.error?.message ?? '未知错误'}`)
  }
  return body.data
}

/** 归一化 folderPath:补前导 /、去尾斜杠;空串与 / 都表示根。 */
function normalizeFolderPath(folderPath: string): string {
  const withLeading = folderPath.startsWith('/') ? folderPath : `/${folderPath}`
  return withLeading.replace(/\/+$/, '') || '/'
}

/**
 * 解析 folderPath → 文件夹 id(工具入参是 path,web-console 端点是 folderId)。
 *
 * @param options - 运行选项
 * @param kbId - 知识库 id
 * @param folderPath - 物化路径(如 /财务/报销)
 * @returns 文件夹 id;根(/)返回 undefined(由调用方按全库处理)
 * @throws Error 文件夹不存在(路径拼错时 fail loud,模型可改用 kb_list 浏览)
 */
async function resolveFolder(
  options: KnowledgeOptions,
  kbId: string,
  folderPath: string,
): Promise<string | undefined> {
  const normalized = normalizeFolderPath(folderPath)
  if (normalized === '/') {
    return undefined
  }
  const folders = await requestJson<KbFolderDto[]>(options, `/api/kb/${kbId}/folders`)
  const folder = folders.find(candidate => normalizeFolderPath(candidate.path) === normalized)
  if (folder === undefined) {
    throw new Error(`知识库文件夹不存在: ${normalized}`)
  }
  return folder.id
}

/** folderId → path 的索引(文档列表结果回填 folderPath 展示用)。 */
function folderPathById(folders: readonly KbFolderDto[]): Map<string, string> {
  return new Map(folders.map(folder => [folder.id, folder.path]))
}

/**
 * 注册代理路由与 kb_search / kb_read / kb_list 工具。
 *
 * <p>webConsoleBaseUrl 在注册前解析一次,格式非法立即失败(misconfiguration
 * fails loud);readMaxChars 必须为正有限数。工具经 {@code ctx.tools.register}
 * 注册,随调用方 fiber 生命周期自动反注册。
 *
 * @param ctx - 携带 `webServer` / `currentUser` / `tools` 的 Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx: Context, config: Config): void {
  const webConsoleBaseUrl = config.webConsoleBaseUrl.replace(/\/+$/, '')
  new URL(webConsoleBaseUrl)
  if (!Number.isFinite(config.readMaxChars) || config.readMaxChars <= 0) {
    throw new Error(`knowledge: readMaxChars 必须为正有限数(当前 ${config.readMaxChars})`)
  }
  const options: KnowledgeOptions = {
    webConsoleBaseUrl,
    readMaxChars: config.readMaxChars,
    token: () => ctx.currentUser.getToken(),
  }
  for (const { local, upstream } of PROXY_ROUTES) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: local,
          handler: (req, res) => proxyRequest(options, local, upstream, req, res),
        }),
      `knowledge: ${local} prefix route`,
    )
  }

  ctx.tools.register(defineTool({
    name: 'kb_search',
    description: 'Search the enterprise knowledge base by keyword (matches document names and extracted text). '
      + 'Documents still being parsed (OCR/extraction) are never returned; get the kbId from the session context '
      + 'or the injected document list, then read full text of a hit with kb_read(docId).',
    parameters: {
      kbId: { type: 'string', required: true, description: 'Knowledge base id (kbId).' },
      query: { type: 'string', required: true, description: 'Keyword to match against names and extracted text.' },
      folderPath: { type: 'string', description: 'Optional folder path (e.g. /finance/reimburse) scoping the search; omit for the whole knowledge base.' },
      topK: { type: 'integer', description: `Maximum number of results (default ${DEFAULT_TOP_K}).` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                docId: { type: 'string', required: true },
                name: { type: 'string', required: true },
                folderPath: { type: 'string', required: true },
                snippet: { type: 'string', required: true },
                parseStatus: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.results.length === 0
            ? '知识库检索:无命中。'
            : `知识库检索 ${value.results.length} 条命中:\n${
              value.results
                .map(r => `- ${r.name} (docId: ${r.docId}, 路径: ${r.folderPath}, 解析: ${r.parseStatus})${r.snippet === '' ? '' : `\n  摘要: ${r.snippet}`}`)
                .join('\n')
            }`,
        },
      ],
    },
    async execute(args) {
      // folderPath 缺省按根路径解析:resolveFolder 对 '/' 直接返回 undefined(不发请求)。
      const folderId = await resolveFolder(options, args.kbId, args.folderPath ?? '/')
      const params = new URLSearchParams({ recursive: 'true', kw: args.query })
      if (folderId !== undefined) {
        params.set('folderId', folderId)
      }
      const [docs, folders] = await Promise.all([
        requestJson<KbDocumentDto[]>(options, `/api/kb/${args.kbId}/documents?${params}`),
        requestJson<KbFolderDto[]>(options, `/api/kb/${args.kbId}/folders`),
      ])
      const pathById = folderPathById(folders)
      const topK = args.topK ?? DEFAULT_TOP_K
      return {
        results: docs.slice(0, topK).map(doc => ({
          docId: doc.id,
          name: doc.name,
          folderPath: doc.folderId === null ? '/' : (pathById.get(doc.folderId) ?? '/'),
          snippet: doc.textExcerpt,
          parseStatus: doc.parseStatus,
        })),
      }
    },
    presentCall: args => ({ card: 'generic', title: '知识库检索', kind: 'search', rawInput: args.query }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_read',
    description: 'Read the extracted full text of one knowledge base document by its docId (returned by kb_search '
      + 'or the injected document list). The result also carries the owning knowledge base id (kbId), '
      + 'which kb_search and kb_list take as their kbId argument. '
      + 'Text longer than the configured limit is truncated and flagged.',
    parameters: {
      docId: { type: 'string', required: true, description: 'Document id (docId).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          kbId: { type: 'string', required: true },
          parseStatus: { type: 'string', required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          // 全文必须进 render:模型可见 ⟺ 已记录,模型只能看到 render 输出。
          // kbId 也进 render:模型从 docId 反查知识库、衔接 kb_search/kb_list 的唯一来源。
          text: value.parseStatus !== 'ready'
            ? `文档「${value.name}」解析状态:${value.parseStatus},暂无全文。(所属知识库 kbId: ${value.kbId})`
            : value.truncated
              ? `知识库文档「${value.name}」全文(超出上限,已截断为前 ${value.text.length} 字符):\n\n${value.text}\n\n(所属知识库 kbId: ${value.kbId})`
              : `知识库文档「${value.name}」全文:\n\n${value.text}\n\n(所属知识库 kbId: ${value.kbId})`,
        },
      ],
    },
    async execute(args) {
      const doc = await requestJson<KbDocumentTextDto>(options, `/api/kb/documents/${args.docId}/text`)
      if (doc.parseStatus !== 'ready') {
        return { name: doc.name, kbId: doc.kbId, parseStatus: doc.parseStatus, text: '', truncated: false }
      }
      const full = doc.textContent ?? ''
      if (full.length <= options.readMaxChars) {
        return { name: doc.name, kbId: doc.kbId, parseStatus: doc.parseStatus, text: full, truncated: false }
      }
      return { name: doc.name, kbId: doc.kbId, parseStatus: doc.parseStatus, text: full.slice(0, options.readMaxChars), truncated: true }
    },
    presentCall: args => ({ card: 'generic', title: '读取知识库文档', kind: 'read', rawInput: args.docId }),
  }))

  ctx.tools.register(defineTool({
    name: 'kb_list',
    description: 'List folders and documents of one knowledge base (whole tree by default, or the subtree under a '
      + 'folder path) to browse what is available before searching or reading. Documents still parsing show their status.',
    parameters: {
      kbId: { type: 'string', required: true, description: 'Knowledge base id (kbId).' },
      folderPath: { type: 'string', description: 'Optional folder path (e.g. /finance) whose subtree is listed; omit for the whole knowledge base.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          folders: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                path: { type: 'string', required: true },
              },
            },
          },
          documents: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                docId: { type: 'string', required: true },
                name: { type: 'string', required: true },
                folderPath: { type: 'string', required: true },
                sizeBytes: { type: 'integer', required: true },
                parseStatus: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `知识库清单:${value.folders.length} 个文件夹,${value.documents.length} 个文档。`,
            ...value.folders.map(f => `- [目录] ${f.path}`),
            ...value.documents.map(d => `- ${d.name} (docId: ${d.docId}, 路径: ${d.folderPath}, 解析: ${d.parseStatus})`),
          ].join('\n'),
        },
      ],
    },
    async execute(args) {
      // folderPath 缺省按根路径解析:resolveFolder 对 '/' 直接返回 undefined(不发请求)。
      const folderId = await resolveFolder(options, args.kbId, args.folderPath ?? '/')
      const params = new URLSearchParams({ recursive: 'true' })
      if (folderId !== undefined) {
        params.set('folderId', folderId)
      }
      const [folders, docs] = await Promise.all([
        requestJson<KbFolderDto[]>(options, `/api/kb/${args.kbId}/folders`),
        requestJson<KbDocumentDto[]>(options, `/api/kb/${args.kbId}/documents?${params}`),
      ])
      const normalized = args.folderPath === undefined ? '/' : normalizeFolderPath(args.folderPath)
      const scopedFolders = normalized === '/'
        ? folders
        : folders.filter(
          folder => folder.path === normalized || folder.path.startsWith(`${normalized}/`),
        )
      const pathById = folderPathById(folders)
      return {
        folders: scopedFolders.map(folder => ({ name: folder.name, path: folder.path })),
        documents: docs.map(doc => ({
          docId: doc.id,
          name: doc.name,
          folderPath: doc.folderId === null ? '/' : (pathById.get(doc.folderId) ?? '/'),
          sizeBytes: doc.sizeBytes,
          parseStatus: doc.parseStatus,
        })),
      }
    },
    presentCall: args => ({ card: 'generic', title: '浏览知识库清单', kind: 'other', rawInput: args.folderPath ?? args.kbId }),
  }))
}
