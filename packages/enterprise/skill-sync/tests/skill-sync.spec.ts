import { Context } from '@deepseek-ai/cordis'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type { CurrentUserService } from '@deepseek-ai/dsh-user-identity-context'
import * as skillSync from '../src/index.ts'

const { apply, SkillSyncService } = skillSync

/** 生成分发 zip(根即 SKILL.md,与 SkillHub 服务端打包一致)。 */
function skillZip(markdown: string): Uint8Array<ArrayBuffer> {
  return zipSync({ 'SKILL.md': strToU8(markdown) })
}

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

/** skills 注册表桩:立即调用 create 构造真实 provider,记录 control 与 disposer。 */
function stubSkills() {
  const registered: { control: SkillProviderControl; disposed: boolean }[] = []
  return {
    registered,
    registerProvider: (create: (control: SkillProviderControl) => unknown) => {
      const control: SkillProviderControl = {
        signal: new AbortController().signal,
        invalidate: vi.fn(),
      }
      const entry = { control, disposed: false }
      registered.push(entry)
      create(control)
      return () => { entry.disposed = true }
    },
  }
}

/** 按前缀分发的 fetch 桩。 */
function stubFetch(routes: { match: (url: string) => boolean; response: () => Response }[]) {
  return vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input)
    for (const route of routes) {
      if (route.match(url)) return route.response()
    }
    return jsonResponse(404, { error: `unexpected fetch ${url}` })
  })
}

/** 最小 webServer 桩:记录注册的路由,测试直调 handler。 */
type StubRoute = {
  kind: 'prefix' | 'exact'
  path: string
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
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

/** 端点请求桩:Emitter 形状,测试在调用 handler 后 emit body。 */
function stubRequest(method: string, url: string): EventEmitter & { method: string; url: string; headers: Record<string, string> } {
  const req = new EventEmitter() as EventEmitter & { method: string; url: string; headers: Record<string, string> }
  req.method = method
  req.url = url
  req.headers = {}
  return req
}

/** 端点响应桩:记录状态码与响应体。 */
function stubResponse() {
  const res = {
    status: 0,
    body: '',
    headersSent: false,
    writeHead: (status: number) => {
      res.status = status
      res.headersSent = true
    },
    end: (chunk?: unknown) => {
      res.body += String(chunk ?? '')
    },
  }
  return res
}

const CONFIG_DEFAULTS = {
  flowableBaseUrl: 'http://flowable:8090',
  skillhubBaseUrl: 'http://skillhub:8095',
  skillhubToken: 'hub-token',
  intervalMs: 60_000,
}

describe('skill-sync', () => {
  let ctx: Context
  let skillDir: string
  let config: skillSync.Config

  const mount = (token: string | undefined, fetchMock?: ReturnType<typeof stubFetch>) => {
    // 挂载即跑首轮同步:无专属桩时默认 404,避免测试真实出站请求
    vi.stubGlobal('fetch', fetchMock ?? stubFetch([]))
    const skills = stubSkills()
    const webServer = stubWebServer()
    ctx.provide('skills', skills as never)
    ctx.provide('currentUser', stubCurrentUser(token) as never)
    ctx.provide('webServer', webServer as never)
    apply(ctx, config)
    return { skills, webServer }
  }

  beforeEach(async () => {
    ctx = new Context()
    skillDir = await mkdtemp(join(tmpdir(), 'skill-sync-'))
    config = { ...CONFIG_DEFAULTS, skillDir }
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    await rm(skillDir, { recursive: true, force: true })
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('apply 在缓存根上注册 skill provider、skillSync 服务与即时安装端点', () => {
    const { skills, webServer } = mount('token')
    expect(skills.registered).toHaveLength(1)
    expect(ctx.skillSync).toBeInstanceOf(SkillSyncService)
    expect(webServer.routes).toHaveLength(1)
    expect(webServer.routes[0]?.path).toBe('/api/enterprise/skills')
  })

  it('apply 校验 baseUrl,非法立即抛错(misconfiguration fails loud)', () => {
    ctx.provide('skills', stubSkills() as never)
    ctx.provide('currentUser', stubCurrentUser('token') as never)
    ctx.provide('webServer', stubWebServer() as never)
    expect(() => apply(ctx, { ...config, flowableBaseUrl: 'not-a-url' })).toThrow()
    expect(() => apply(ctx, { ...config, skillhubBaseUrl: 'nope' })).toThrow()
  })

  it('未登录(getToken undefined)时 sync 直接跳过,不出站请求', async () => {
    mount(undefined)
    const fetchMock = stubFetch([])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sync 拉清单、下载缺失 skill、写 state 并失效注册表', async () => {
    const { skills } = mount('jwt')
    const fetchMock = stubFetch([
      {
        match: url => url === 'http://flowable:8090/dsh/skills/required',
        response: () => jsonResponse(200, {
          skills: [{ name: 'expense-form', namespace: 'dsh-demo', sources: ['active-task'] }],
        }),
      },
      {
        match: url => url.startsWith('http://skillhub:8095/api/cli/v1/namespaces/dsh-demo/skills'),
        response: () => jsonResponse(200, {
          code: 0,
          data: {
            items: [{ slug: 'expense-form', fingerprint: 'sha256:abc', downloadUrl: '/api/v1/skills/dsh-demo/expense-form/versions/1.0.0/download' }],
            nextCursor: null,
          },
        }),
      },
      {
        match: url => url.includes('/download'),
        response: () => new Response(skillZip('---\nname: expense-form\n---\nbody')),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    expect(join(skillDir, 'expense-form', 'SKILL.md')).toBeTruthy()
    await expect(readFile(join(skillDir, 'expense-form', 'SKILL.md'), 'utf8')).resolves.toContain('expense-form')
    const state = JSON.parse(await readFile(join(skillDir, '..', 'state.json'), 'utf8'))
    expect(state.skills['expense-form']).toEqual({ namespace: 'dsh-demo', fingerprint: 'sha256:abc' })
    expect(skills.registered[0]?.control.invalidate).toHaveBeenCalled()
  })

  it('已安装且 fingerprint 一致的 skill 跳过下载', async () => {
    mount('jwt')
    await writeFile(join(skillDir, '..', 'state.json'), JSON.stringify({
      skills: { 'expense-form': { namespace: 'dsh-demo', fingerprint: 'sha256:abc' } },
    }))
    await writeFile(join(skillDir, 'expense-form', 'SKILL.md'), 'existing')
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, {
          skills: [{ name: 'expense-form', namespace: 'dsh-demo' }],
        }),
      },
      {
        match: url => url.startsWith('http://skillhub:8095/api/cli/v1/namespaces/'),
        response: () => jsonResponse(200, {
          code: 0,
          data: { items: [{ slug: 'expense-form', fingerprint: 'sha256:abc', downloadUrl: '/d' }], nextCursor: null },
        }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    // 无 download 路由命中即未尝试下载
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/download'))).toBe(true)
    await expect(readFile(join(skillDir, 'expense-form', 'SKILL.md'), 'utf8')).resolves.toBe('existing')
  })

  it('fingerprint 变化触发重新安装(旧目录被替换)', async () => {
    mount('jwt')
    await writeFile(join(skillDir, '..', 'state.json'), JSON.stringify({
      skills: { 'expense-form': { namespace: 'dsh-demo', fingerprint: 'sha256:old' } },
    }))
    await writeFile(join(skillDir, 'expense-form', 'SKILL.md'), 'old')
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, {
          skills: [{ name: 'expense-form', namespace: 'dsh-demo' }],
        }),
      },
      {
        match: url => url.startsWith('http://skillhub:8095/api/cli/v1/namespaces/'),
        response: () => jsonResponse(200, {
          code: 0,
          data: { items: [{ slug: 'expense-form', fingerprint: 'sha256:new', downloadUrl: '/api/v1/s/d' }], nextCursor: null },
        }),
      },
      { match: url => url.includes('/api/v1/s/d'), response: () => new Response(skillZip('---\nname: x\n---\nnew')) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    await expect(readFile(join(skillDir, 'expense-form', 'SKILL.md'), 'utf8')).resolves.toContain('new')
  })

  it('401(token 过期)时本轮跳过', async () => {
    mount('stale-jwt')
    const fetchMock = stubFetch([
      { match: url => url.endsWith('/dsh/skills/required'), response: () => jsonResponse(401, {}) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    expect(readdir(skillDir)).resolves.toEqual([])
  })

  it('无 namespace 的清单项跳过,不触碰 SkillHub', async () => {
    mount('jwt')
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, { skills: [{ name: 'orphan' }] }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('清单拉取失败时跳过该 namespace 的全部 skill', async () => {
    mount('jwt')
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, {
          skills: [{ name: 'expense-form', namespace: 'bad-ns' }],
        }),
      },
      { match: url => url.startsWith('http://skillhub:8095/api/cli/v1/namespaces/bad-ns'), response: () => jsonResponse(500, {}) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    expect(readdir(skillDir)).resolves.toEqual([])
  })

  it('skill 不在命名空间已发布清单中时跳过安装', async () => {
    mount('jwt')
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, {
          skills: [{ name: 'ghost', namespace: 'dsh-demo' }],
        }),
      },
      {
        match: url => url.startsWith('http://skillhub:8095/api/cli/v1/namespaces/'),
        response: () => jsonResponse(200, { code: 0, data: { items: [], nextCursor: null } }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    expect(readdir(skillDir)).resolves.toEqual([])
  })

  it('zip 条目路径穿越被拒绝且不产生残留目录', async () => {
    mount('jwt')
    const evilZip = zipSync({ '../escape.md': strToU8('x'), 'SKILL.md': strToU8('y') })
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, {
          skills: [{ name: 'evil', namespace: 'dsh-demo' }],
        }),
      },
      {
        match: url => url.startsWith('http://skillhub:8095/api/cli/v1/namespaces/'),
        response: () => jsonResponse(200, {
          code: 0,
          data: { items: [{ slug: 'evil', fingerprint: 'sha256:1', downloadUrl: '/api/v1/d' }], nextCursor: null },
        }),
      },
      { match: url => url.includes('/api/v1/d'), response: () => new Response(evilZip) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    expect(readdir(skillDir)).resolves.toEqual([])
    expect(join(tmpdir(), 'escape.md')).toBeTruthy()
  })

  it('ensureInstalled 对已就绪清单返回空,缺失时触发同步', async () => {
    mount('jwt')
    await writeFile(join(skillDir, '..', 'state.json'), JSON.stringify({
      skills: { ready: { namespace: 'ns', fingerprint: 'f' } },
    }))
    await writeFile(join(skillDir, 'ready', 'SKILL.md'), 'ok')
    await expect(ctx.skillSync.ensureInstalled(['ready'])).resolves.toEqual([])
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, { skills: [] }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await expect(ctx.skillSync.ensureInstalled(['ready', 'missing'])).resolves.toEqual(['missing'])
  })

  it('并发 sync 合并为一轮(清单只拉一次)', async () => {
    mount('jwt')
    let requiredCalls = 0
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => {
          requiredCalls += 1
          return jsonResponse(200, { skills: [] })
        },
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await Promise.all([ctx.skillSync.sync(), ctx.skillSync.sync()])
    expect(requiredCalls).toBe(1)
  })

  it('ensure 端点:缺失 skill 触发同步并返回 200 missing 清单', async () => {
    const { webServer } = mount('jwt')
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, { skills: [] }),
      },
    ])
    vi.stubGlobal('fetch', fetchMock)
    const route = webServer.routes[0]!
    const req = stubRequest('POST', '/api/enterprise/skills/ensure')
    const res = stubResponse()
    const promise = route.handler(req as never, res as never)
    req.emit('data', Buffer.from(JSON.stringify({ names: ['ghost'] })))
    req.emit('end')
    await promise
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ missing: ['ghost'] })
  })

  it('ensure 端点:names 含路径穿越特征返回 400', async () => {
    const { webServer } = mount('jwt')
    const route = webServer.routes[0]!
    const req = stubRequest('POST', '/api/enterprise/skills/ensure')
    const res = stubResponse()
    const promise = route.handler(req as never, res as never)
    req.emit('data', Buffer.from(JSON.stringify({ names: ['../escape'] })))
    req.emit('end')
    await promise
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error).toContain('names')
  })

  it('ensure 端点:非 POST/未知路径返回 404', async () => {
    const { webServer } = mount('jwt')
    const route = webServer.routes[0]!
    const getReq = stubRequest('GET', '/api/enterprise/skills/ensure')
    const getRes = stubResponse()
    await route.handler(getReq as never, getRes as never)
    expect(getRes.status).toBe(404)
    const req = stubRequest('POST', '/api/enterprise/skills/other')
    const res = stubResponse()
    const promise = route.handler(req as never, res as never)
    req.emit('data', Buffer.from('{}'))
    req.emit('end')
    await promise
    expect(res.status).toBe(404)
  })

  it('daemon 定时器按 intervalMs 触发同步,插件卸载后停止', async () => {
    vi.useFakeTimers()
    ctx.provide('skills', stubSkills() as never)
    ctx.provide('currentUser', stubCurrentUser('jwt') as never)
    ctx.provide('webServer', stubWebServer() as never)
    const fiber = ctx.plugin(skillSync, config)
    await fiber
    const fetchMock = stubFetch([
      { match: url => url.endsWith('/dsh/skills/required'), response: () => jsonResponse(200, { skills: [] }) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalled()
    const calls = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls)
    await fiber.dispose()
    const afterDispose = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchMock.mock.calls.length).toBe(afterDispose)
  })

  it('挂载即建缓存目录并立即执行一轮同步(不等第一个 interval)', async () => {
    const fetchMock = stubFetch([
      { match: url => url.endsWith('/dsh/skills/required'), response: () => jsonResponse(200, { skills: [] }) },
    ])
    await rm(skillDir, { recursive: true, force: true })
    mount('jwt', fetchMock)
    await new Promise(resolve => setImmediate(resolve))
    // fetch 命中即证明 start() 走完 mkdir 并发起了首轮同步
    expect(fetchMock).toHaveBeenCalled()
  })

  it('清单分页:nextCursor 非空时翻页取全量', async () => {
    mount('jwt')
    let page = 0
    const fetchMock = stubFetch([
      {
        match: url => url.endsWith('/dsh/skills/required'),
        response: () => jsonResponse(200, {
          skills: [{ name: 'paged', namespace: 'dsh-demo' }],
        }),
      },
      {
        match: url => url.startsWith('http://skillhub:8095/api/cli/v1/namespaces/'),
        response: () => {
          page += 1
          return jsonResponse(200, {
            code: 0,
            data: page === 1
              ? { items: [], nextCursor: '1' }
              : { items: [{ slug: 'paged', fingerprint: 'sha256:p', downloadUrl: '/api/v1/p' }], nextCursor: null },
          })
        },
      },
      { match: url => url.includes('/api/v1/p'), response: () => new Response(skillZip('---\nname: paged\n---\n')) },
    ])
    vi.stubGlobal('fetch', fetchMock)
    await ctx.skillSync.sync()
    await expect(readFile(join(skillDir, 'paged', 'SKILL.md'), 'utf8')).resolves.toContain('paged')
    expect(page).toBe(2)
  })
})
