import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CurrentUserService } from '@deepseek-ai/dsh-user-identity-context'
import * as knowledge from '../src/index.ts'

const { apply } = knowledge

/** 构造 JSON Response。 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 最小 currentUser 桩:只暴露 getToken。 */
function stubCurrentUser(token: string | undefined) {
  return { getToken: () => token } as unknown as CurrentUserService
}

/** 测试直调的工具面:execute / output.render / presentCall。 */
interface StubTool {
  readonly name: string
  readonly execute: (args: never, exec: unknown) => Promise<unknown>
  readonly output: { render: (args: never, value: never) => unknown[] }
  readonly presentCall: (args: never) => unknown
}

/** tools 注册表桩:记录注册的工具定义,返回空 disposer。 */
function stubTools() {
  const registered: StubTool[] = []
  return {
    registered,
    register: (definition: unknown) => {
      registered.push(definition as StubTool)
      return () => {}
    },
  }
}

/** webServer 桩:记录注册的路由,测试直调 handler。 */
type StubRoute = {
  kind: 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
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

/** proxyRequest 转发给 fetch 的初始化参数。 */
interface StubFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: Uint8Array | null
}

/** 按前缀分发的 fetch 桩;response 抛错即上游网络失败。 */
function stubFetch(routes: { match: (url: string) => boolean; response: () => Response }[]) {
  return vi.fn(async (input: URL | RequestInfo, _init?: StubFetchInit) => {
    const url = String(input)
    for (const route of routes) {
      if (route.match(url)) return route.response()
    }
    return jsonResponse(404, { error: `unexpected fetch ${url}` })
  })
}

/** 端点请求桩:Emitter 形状 + 异步迭代器(readBody 整体缓冲请求体)。 */
function stubRequest(method: string, url: string, body?: Buffer) {
  const req = new EventEmitter() as EventEmitter & {
    method: string
    url: string
    headers: Record<string, string>
    [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>
  }
  req.method = method
  req.url = url
  req.headers = {}
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
  }
  return res
}

const CONFIG = {
  // 尾斜杠覆盖 apply 的去尾逻辑;断言里的上游地址是无尾斜杠形态。
  webConsoleBaseUrl: 'http://console:8080/',
  readMaxChars: 100,
}

const FOLDERS = [
  { id: 'f1', name: '财务', path: '/财务' },
  { id: 'f2', name: '报销', path: '/财务/报销' },
  { id: 'f3', name: '人事', path: '/人事' },
]

const DOCS = [
  { id: 'doc0', name: '根文档', folderId: null, sizeBytes: 10, parseStatus: 'ready', textExcerpt: 'e0' },
  { id: 'doc1', name: '财务文档', folderId: 'f1', sizeBytes: 20, parseStatus: 'ready', textExcerpt: 'e1' },
  { id: 'doc2', name: '报销文档', folderId: 'f2', sizeBytes: 30, parseStatus: 'parsing', textExcerpt: 'e2' },
  // folderId 不在 folders 索引中:folderPath 回退根路径。
  { id: 'doc3', name: '孤儿文档', folderId: 'no-such-folder', sizeBytes: 40, parseStatus: 'ready', textExcerpt: 'e3' },
]

/** web-console folders/documents 端点桩(kb_search / kb_list 共用)。 */
const consoleRoutes = (documents: unknown[], folders: unknown[] = FOLDERS) => [
  {
    match: (url: string) => url === 'http://console:8080/api/kb/kb1/folders',
    response: () => jsonResponse(200, { success: true, data: folders }),
  },
  {
    match: (url: string) => url.startsWith('http://console:8080/api/kb/kb1/documents'),
    response: () => jsonResponse(200, { success: true, data: documents }),
  },
]

interface SearchHit {
  docId: string
  name: string
  folderPath: string
  snippet: string
  parseStatus: string
}

interface ListResult {
  folders: { name: string; path: string }[]
  documents: { docId: string; name: string; folderPath: string; sizeBytes: number; parseStatus: string }[]
}

describe('knowledge', () => {
  let ctx: Context

  const mount = (token: string | undefined, fetchMock: ReturnType<typeof stubFetch> = stubFetch([])) => {
    vi.stubGlobal('fetch', fetchMock)
    const tools = stubTools()
    const webServer = stubWebServer()
    ctx.provide('tools', tools as never)
    ctx.provide('currentUser', stubCurrentUser(token) as never)
    ctx.provide('webServer', webServer as never)
    apply(ctx, { ...CONFIG })
    return { tools, webServer }
  }

  const toolOf = (tools: ReturnType<typeof stubTools>, toolName: string): StubTool => {
    const found = tools.registered.find(candidate => candidate.name === toolName)
    if (found === undefined) throw new Error(`tool ${toolName} not registered`)
    return found
  }

  const execute = (tool: StubTool, args: unknown) =>
    tool.execute(args as never, { signal: new AbortController().signal } as never)

  const routeOf = (webServer: ReturnType<typeof stubWebServer>, path: string) => {
    const found = webServer.routes.find(route => route.path === path)
    if (found === undefined) throw new Error(`route ${path} not registered`)
    return found
  }

  beforeEach(() => {
    ctx = new Context()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('apply 注册两条前缀路由与三个知识库工具', () => {
    const { tools, webServer } = mount('jwt')
    expect(webServer.routes.map(route => route.path).sort()).toEqual([
      '/api/enterprise/apps',
      '/api/enterprise/kb',
    ])
    expect(webServer.routes.every(route => route.kind === 'prefix')).toBe(true)
    expect(tools.registered.map(tool => tool.name).sort()).toEqual(['kb_list', 'kb_read', 'kb_search'])
  })

  it('apply 校验配置:非法 baseUrl 与 readMaxChars 立即抛错(misconfiguration fails loud)', () => {
    vi.stubGlobal('fetch', stubFetch([]))
    ctx.provide('tools', stubTools() as never)
    ctx.provide('currentUser', stubCurrentUser('jwt') as never)
    ctx.provide('webServer', stubWebServer() as never)
    expect(() => apply(ctx, { ...CONFIG, webConsoleBaseUrl: 'not-a-url' })).toThrow()
    expect(() => apply(ctx, { ...CONFIG, readMaxChars: 0 })).toThrow('readMaxChars')
    expect(() => apply(ctx, { ...CONFIG, readMaxChars: Number.NaN })).toThrow('readMaxChars')
    expect(() => apply(ctx, { ...CONFIG, readMaxChars: Number.POSITIVE_INFINITY })).toThrow('readMaxChars')
  })

  it('代理:未登录返回 401', async () => {
    const { webServer } = mount(undefined)
    const res = stubResponse()
    await routeOf(webServer, '/api/enterprise/kb')
      .handler(stubRequest('GET', '/api/enterprise/kb/kb1/folders') as never, res as never)
    expect(res.status).toBe(401)
    expect(JSON.parse(res.body).error).toContain('未登录')
  })

  it('代理:GET 转发改写前缀、附 JWT,上游响应原样回写', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/kb/kb1/documents?kw=invoice',
      response: () => jsonResponse(200, { success: true, data: [] }),
    }])
    const { webServer } = mount('jwt', fetchMock)
    const res = stubResponse()
    await routeOf(webServer, '/api/enterprise/kb')
      .handler(stubRequest('GET', '/api/enterprise/kb/kb1/documents?kw=invoice') as never, res as never)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/json')
    expect(JSON.parse(res.body)).toEqual({ success: true, data: [] })
    const [input, init] = fetchMock.mock.calls[0]!
    expect(String(input)).toBe('http://console:8080/api/kb/kb1/documents?kw=invoice')
    expect(init?.method).toBe('GET')
    expect(init?.headers).toEqual({ authorization: 'Bearer jwt' })
    expect(init?.body).toBeNull()
  })

  it('代理:POST 转发请求体与 content-type', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/kb/kb1/documents',
      response: () => jsonResponse(200, { success: true, data: {} }),
    }])
    const { webServer } = mount('jwt', fetchMock)
    const req = stubRequest('POST', '/api/enterprise/kb/kb1/documents', Buffer.from('{"a":1}'))
    req.headers['content-type'] = 'application/json'
    const res = stubResponse()
    await routeOf(webServer, '/api/enterprise/kb').handler(req as never, res as never)
    expect(res.status).toBe(200)
    const [, init] = fetchMock.mock.calls[0]!
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({ authorization: 'Bearer jwt', 'content-type': 'application/json' })
    expect(Buffer.from(init?.body as Uint8Array).toString()).toBe('{"a":1}')
  })

  it('代理:web-console 不可达返回 JSON 502', async () => {
    const fetchMock = stubFetch([{ match: () => true, response: () => { throw new Error('ECONNREFUSED') } }])
    const { webServer } = mount('jwt', fetchMock)
    const res = stubResponse()
    await routeOf(webServer, '/api/enterprise/kb')
      .handler(stubRequest('GET', '/api/enterprise/kb/kb1/folders') as never, res as never)
    expect(res.status).toBe(502)
    expect(JSON.parse(res.body).error).toContain('web-console 不可达')
  })

  it('代理:fetch 抛非 Error 值时同样返回 502', async () => {
    const fetchMock = stubFetch([{ match: () => true, response: () => { throw 'boom' } }])
    const { webServer } = mount('jwt', fetchMock)
    const res = stubResponse()
    await routeOf(webServer, '/api/enterprise/kb')
      .handler(stubRequest('GET', '/api/enterprise/kb/kb1/folders') as never, res as never)
    expect(res.status).toBe(502)
    expect(JSON.parse(res.body).error).toContain('boom')
  })

  it('代理:上游响应缺 content-type 时回写默认 JSON 类型', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      // null body 的 Response 不携带 content-type 头。
      response: () => new Response(null, { status: 201 }),
    }])
    const { webServer } = mount('jwt', fetchMock)
    const res = stubResponse()
    await routeOf(webServer, '/api/enterprise/kb')
      .handler(stubRequest('GET', '/api/enterprise/kb/kb1/folders') as never, res as never)
    expect(res.status).toBe(201)
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
  })

  it('代理:apps 前缀同样改写转发', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/apps/mine',
      response: () => jsonResponse(200, { success: true, data: [] }),
    }])
    const { webServer } = mount('jwt', fetchMock)
    const res = stubResponse()
    await routeOf(webServer, '/api/enterprise/apps')
      .handler(stubRequest('GET', '/api/enterprise/apps/mine') as never, res as never)
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('kb_search:全库检索映射 folderPath,默认 topK 截断,render/presentCall 可用', async () => {
    const manyDocs = Array.from({ length: 10 }, (_, i) => ({
      id: `doc${i}`,
      name: `文档${i}`,
      folderId: i === 0 ? null : i === 1 ? 'f1' : i === 2 ? 'no-such-folder' : 'f2',
      sizeBytes: 10 + i,
      parseStatus: 'ready',
      textExcerpt: `摘录${i}`,
    }))
    const fetchMock = stubFetch(consoleRoutes(manyDocs))
    const { tools } = mount('jwt', fetchMock)
    const search = toolOf(tools, 'kb_search')
    const result = await execute(search, { kbId: 'kb1', query: '发票' }) as { results: SearchHit[] }
    expect(result.results).toHaveLength(8)
    expect(result.results[0]).toEqual({
      docId: 'doc0', name: '文档0', folderPath: '/', snippet: '摘录0', parseStatus: 'ready',
    })
    expect(result.results[1]?.folderPath).toBe('/财务')
    expect(result.results[2]?.folderPath).toBe('/')
    expect(result.results[3]?.folderPath).toBe('/财务/报销')
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('folderId'))).toBe(false)
    expect(search.output.render(undefined as never, result as never)).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('知识库检索 8 条命中:\n- 文档0 (docId: doc0, 路径: /, 解析: ready)\n  摘要: 摘录0'),
      },
    ])
    expect(search.presentCall({ kbId: 'kb1', query: '发票' } as never)).toEqual({
      card: 'generic', title: '知识库检索', kind: 'search', rawInput: '发票',
    })
  })

  it('kb_search:无命中时 render 提示无命中', async () => {
    const fetchMock = stubFetch(consoleRoutes([]))
    const { tools } = mount('jwt', fetchMock)
    const search = toolOf(tools, 'kb_search')
    const result = await execute(search, { kbId: 'kb1', query: '不存在' }) as { results: SearchHit[] }
    expect(result.results).toHaveLength(0)
    expect(search.output.render(undefined as never, result as never)).toEqual([
      { type: 'text', text: '知识库检索:无命中。' },
    ])
  })

  it('kb_search:folderPath 解析为 folderId 并限定范围,尾斜杠归一化,topK 生效', async () => {
    const fetchMock = stubFetch(consoleRoutes(DOCS))
    const { tools } = mount('jwt', fetchMock)
    const result = await execute(toolOf(tools, 'kb_search'), {
      kbId: 'kb1', query: '发票', folderPath: '/财务/', topK: 1,
    }) as { results: SearchHit[] }
    expect(result.results).toHaveLength(1)
    const docCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/documents'))
    expect(String(docCall?.[0])).toContain('recursive=true')
    expect(String(docCall?.[0])).toContain('folderId=f1')
  })

  it('kb_search:folderPath 无前导斜杠时补齐后解析', async () => {
    const fetchMock = stubFetch(consoleRoutes(DOCS))
    const { tools } = mount('jwt', fetchMock)
    await execute(toolOf(tools, 'kb_search'), { kbId: 'kb1', query: 'x', folderPath: '财务' })
    const docCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/documents'))
    expect(String(docCall?.[0])).toContain('folderId=f1')
  })

  it('kb_search:folderPath 为根("/")等价全库,不附 folderId', async () => {
    const fetchMock = stubFetch(consoleRoutes(DOCS))
    const { tools } = mount('jwt', fetchMock)
    const result = await execute(toolOf(tools, 'kb_search'), { kbId: 'kb1', query: 'x', folderPath: '/' }) as { results: SearchHit[] }
    expect(result.results).toHaveLength(DOCS.length)
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('folderId'))).toBe(false)
  })

  it('kb_search:folderPath 不存在时抛错', async () => {
    const fetchMock = stubFetch(consoleRoutes(DOCS, []))
    const { tools } = mount('jwt', fetchMock)
    await expect(execute(toolOf(tools, 'kb_search'), {
      kbId: 'kb1', query: 'x', folderPath: '/不存在',
    })).rejects.toThrow('知识库文件夹不存在')
  })

  it('kb_read:ready 文档返回全文与 kbId,render/presentCall 可用', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/kb/documents/doc1/text',
      response: () => jsonResponse(200, {
        success: true,
        data: { id: 'doc1', kbId: 'kb1', name: '报销规范', textContent: 'x'.repeat(50), parseStatus: 'ready' },
      }),
    }])
    const { tools } = mount('jwt', fetchMock)
    const read = toolOf(tools, 'kb_read')
    const result = await execute(read, { docId: 'doc1' }) as { name: string; kbId: string; text: string; truncated: boolean }
    expect(result).toEqual({ name: '报销规范', kbId: 'kb1', parseStatus: 'ready', text: 'x'.repeat(50), truncated: false })
    expect(read.output.render(undefined as never, result as never)).toEqual([
      { type: 'text', text: `知识库文档「报销规范」全文:\n\n${'x'.repeat(50)}\n\n(所属知识库 kbId: kb1)` },
    ])
    expect(read.presentCall({ docId: 'doc1' } as never)).toEqual({
      card: 'generic', title: '读取知识库文档', kind: 'read', rawInput: 'doc1',
    })
  })

  it('kb_read:超限文本截断并标记,render 注明截断', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/kb/documents/doc1/text',
      response: () => jsonResponse(200, {
        success: true,
        data: { id: 'doc1', kbId: 'kb1', name: '长文', textContent: 'x'.repeat(150), parseStatus: 'ready' },
      }),
    }])
    const { tools } = mount('jwt', fetchMock)
    const read = toolOf(tools, 'kb_read')
    const result = await execute(read, { docId: 'doc1' }) as { text: string; truncated: boolean }
    expect(result.text).toBe('x'.repeat(100))
    expect(result.truncated).toBe(true)
    expect(read.output.render(undefined as never, result as never)).toEqual([
      { type: 'text', text: `知识库文档「长文」全文(超出上限,已截断为前 100 字符):\n\n${'x'.repeat(100)}\n\n(所属知识库 kbId: kb1)` },
    ])
  })

  it('kb_read:非 ready 状态返回空文本,render 呈现解析状态与 kbId', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/kb/documents/doc1/text',
      response: () => jsonResponse(200, {
        success: true,
        data: { id: 'doc1', kbId: 'kb1', name: '解析中', textContent: null, parseStatus: 'parsing' },
      }),
    }])
    const { tools } = mount('jwt', fetchMock)
    const read = toolOf(tools, 'kb_read')
    const result = await execute(read, { docId: 'doc1' }) as { text: string; truncated: boolean }
    expect(result).toEqual({ name: '解析中', kbId: 'kb1', parseStatus: 'parsing', text: '', truncated: false })
    expect(read.output.render(undefined as never, result as never)).toEqual([
      { type: 'text', text: '文档「解析中」解析状态:parsing,暂无全文。(所属知识库 kbId: kb1)' },
    ])
  })

  it('kb_read:ready 但 textContent 缺失按空文本处理', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/kb/documents/doc1/text',
      response: () => jsonResponse(200, {
        success: true,
        data: { id: 'doc1', kbId: 'kb1', name: '空文', textContent: null, parseStatus: 'ready' },
      }),
    }])
    const { tools } = mount('jwt', fetchMock)
    const result = await execute(toolOf(tools, 'kb_read'), { docId: 'doc1' }) as { text: string; truncated: boolean }
    expect(result).toEqual({ name: '空文', kbId: 'kb1', parseStatus: 'ready', text: '', truncated: false })
  })

  it('kb_read:未登录时抛错', async () => {
    const { tools } = mount(undefined)
    await expect(execute(toolOf(tools, 'kb_read'), { docId: 'doc1' })).rejects.toThrow('未登录')
  })

  it('kb_read:上游不可达时抛 502 消息', async () => {
    const fetchMock = stubFetch([{ match: () => true, response: () => { throw new Error('ECONNREFUSED') } }])
    const { tools } = mount('jwt', fetchMock)
    await expect(execute(toolOf(tools, 'kb_read'), { docId: 'doc1' })).rejects.toThrow('web-console 不可达')
  })

  it('kb_read:fetch 抛非 Error 值时同样抛 502 消息', async () => {
    const fetchMock = stubFetch([{ match: () => true, response: () => { throw 'boom' } }])
    const { tools } = mount('jwt', fetchMock)
    await expect(execute(toolOf(tools, 'kb_read'), { docId: 'doc1' })).rejects.toThrow('boom')
  })

  it('kb_read:响应非 JSON 时抛错', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => new Response('<html>oops</html>', { headers: { 'content-type': 'text/html' } }),
    }])
    const { tools } = mount('jwt', fetchMock)
    await expect(execute(toolOf(tools, 'kb_read'), { docId: 'doc1' })).rejects.toThrow('不是 JSON')
  })

  it('kb_read:信封失败时透出上游错误消息', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => jsonResponse(401, { success: false, error: { message: 'token 过期' } }),
    }])
    const { tools } = mount('jwt', fetchMock)
    await expect(execute(toolOf(tools, 'kb_read'), { docId: 'doc1' })).rejects.toThrow('token 过期')
  })

  it('kb_read:信封无 data 且无错误消息时抛未知错误', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => jsonResponse(200, { success: true }),
    }])
    const { tools } = mount('jwt', fetchMock)
    await expect(execute(toolOf(tools, 'kb_read'), { docId: 'doc1' })).rejects.toThrow('未知错误')
  })

  it('kb_list:全库清单列出全部文件夹与文档,render/presentCall 可用', async () => {
    const fetchMock = stubFetch(consoleRoutes(DOCS))
    const { tools } = mount('jwt', fetchMock)
    const list = toolOf(tools, 'kb_list')
    const result = await execute(list, { kbId: 'kb1' }) as ListResult
    expect(result.folders).toEqual([
      { name: '财务', path: '/财务' },
      { name: '报销', path: '/财务/报销' },
      { name: '人事', path: '/人事' },
    ])
    expect(result.documents).toEqual([
      { docId: 'doc0', name: '根文档', folderPath: '/', sizeBytes: 10, parseStatus: 'ready' },
      { docId: 'doc1', name: '财务文档', folderPath: '/财务', sizeBytes: 20, parseStatus: 'ready' },
      { docId: 'doc2', name: '报销文档', folderPath: '/财务/报销', sizeBytes: 30, parseStatus: 'parsing' },
      { docId: 'doc3', name: '孤儿文档', folderPath: '/', sizeBytes: 40, parseStatus: 'ready' },
    ])
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('folderId'))).toBe(false)
    expect(list.output.render(undefined as never, result as never)).toEqual([
      {
        type: 'text',
        text: [
          '知识库清单:3 个文件夹,4 个文档。',
          '- [目录] /财务',
          '- [目录] /财务/报销',
          '- [目录] /人事',
          '- 根文档 (docId: doc0, 路径: /, 解析: ready)',
          '- 财务文档 (docId: doc1, 路径: /财务, 解析: ready)',
          '- 报销文档 (docId: doc2, 路径: /财务/报销, 解析: parsing)',
          '- 孤儿文档 (docId: doc3, 路径: /, 解析: ready)',
        ].join('\n'),
      },
    ])
    expect(list.presentCall({ kbId: 'kb1' } as never)).toEqual({
      card: 'generic', title: '浏览知识库清单', kind: 'other', rawInput: 'kb1',
    })
  })

  it('kb_list:folderPath 子树过滤文件夹,presentCall 用 folderPath', async () => {
    const fetchMock = stubFetch(consoleRoutes(DOCS))
    const { tools } = mount('jwt', fetchMock)
    const list = toolOf(tools, 'kb_list')
    const result = await execute(list, { kbId: 'kb1', folderPath: '财务' }) as ListResult
    expect(result.folders).toEqual([
      { name: '财务', path: '/财务' },
      { name: '报销', path: '/财务/报销' },
    ])
    const docCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/documents'))
    expect(String(docCall?.[0])).toContain('folderId=f1')
    expect(list.presentCall({ kbId: 'kb1', folderPath: '财务' } as never)).toEqual({
      card: 'generic', title: '浏览知识库清单', kind: 'other', rawInput: '财务',
    })
  })

  it('kb_list:folderPath 不存在时抛错', async () => {
    const fetchMock = stubFetch(consoleRoutes(DOCS, []))
    const { tools } = mount('jwt', fetchMock)
    await expect(execute(toolOf(tools, 'kb_list'), {
      kbId: 'kb1', folderPath: '/不存在',
    })).rejects.toThrow('知识库文件夹不存在')
  })
})
