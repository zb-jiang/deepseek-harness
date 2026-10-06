import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlatformUser, PlatformUserId } from '@deepseek-ai/dsh-platform-user'
import type { CurrentUserService } from '@deepseek-ai/dsh-user-identity-context'
import { mapEnterpriseFailure } from '../src/adapter.ts'
import { buildEnterpriseProfiles, ENTERPRISE_PROVIDER, fetchEnterpriseModels } from '../src/catalog.ts'
import * as llmAccess from '../src/index.ts'

const { apply } = llmAccess

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

/** llm 注册表桩:记录 register/replace/dispose 调用。 */
function stubLlm() {
  const calls: { kind: 'register' | 'replace' | 'dispose'; routes: string[] }[] = []
  return {
    calls,
    registerAdapter: (routes: string[], _adapter: unknown) => {
      calls.push({ kind: 'register', routes: [...routes] })
      return Object.assign(() => {
        calls.push({ kind: 'dispose', routes: [] })
      }, {
        replace: (next: string[]) => {
          calls.push({ kind: 'replace', routes: [...next] })
        },
      })
    },
  }
}

const volatileOf = <T>(value: T): { get: () => T } => ({ get: () => value })

const CONFIG = {
  webConsoleBaseUrl: volatileOf('http://console:8080'),
  catalogRefreshMs: 600_000,
  catalogEmptyRefreshMs: 60_000,
  catalogReadRefreshMs: 30_000,
  defaultContextWindow: 262_144,
  defaultMaxTokens: 32_768,
}

/** 合法 PlatformUser 载荷(verified 事件用)。 */
const platformUser = (): PlatformUser => ({
  id: 'u1' as PlatformUserId,
  authSubject: 'sub-1',
  loginName: 'zhang',
  displayName: '张三',
  email: 'zhang@example.com',
  status: 'active',
  platformRoles: ['normal_user'],
  createdAt: '2026-01-01T00:00:00Z',
})

const MODELS_V1 = [{
  id: 'm1', gatewayModelName: 'enterprise-chat', displayName: '企业对话',
  contextWindow: 128_000, maxTokens: 8_192, exhaustAction: 'block', pools: [],
}]

const MODELS_V2 = [
  MODELS_V1[0],
  { id: 'm2', gatewayModelName: 'enterprise-reasoner', displayName: '企业推理', contextWindow: null, maxTokens: null },
]

describe('fetchEnterpriseModels', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('成功:归一化目录,null 容量/缺失展示名回退,reasoning/imageInput 仅 true 透出', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      success: true,
      data: [
        { id: 'm1', gatewayModelName: 'enterprise-chat', displayName: '企业对话', contextWindow: 128_000, maxTokens: 8_192 },
        { id: 'm2', gatewayModelName: 'enterprise-reasoner', displayName: null, contextWindow: null, maxTokens: null, reasoning: true, imageInput: true },
        { id: 'm3', gatewayModelName: '', displayName: '空网关名跳过' },
        { id: 'm4', gatewayModelName: 'enterprise-chat', displayName: '重复条目跳过' },
      ],
    })))
    const models = await fetchEnterpriseModels({ webConsoleBaseUrl: 'http://console:8080', token: 'jwt' })
    expect(models).toEqual([
      { gatewayModelName: 'enterprise-chat', displayName: '企业对话', contextWindow: 128_000, maxTokens: 8_192, reasoning: false, imageInput: false },
      { gatewayModelName: 'enterprise-reasoner', displayName: 'enterprise-reasoner', contextWindow: undefined, maxTokens: undefined, reasoning: true, imageInput: true },
    ])
  })

  it('信封失败:抛出携带服务端消息的错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, {
      success: false,
      error: { code: 'LLM_ROUTE_NOT_CONFIGURED', message: '该模型未配置额度路由' },
    })))
    await expect(fetchEnterpriseModels({ webConsoleBaseUrl: 'http://console:8080', token: 'jwt' }))
      .rejects.toThrow('web-console 模型目录请求失败(HTTP 403): 该模型未配置额度路由')
  })

  it('网络不可达:抛出不可达错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    await expect(fetchEnterpriseModels({ webConsoleBaseUrl: 'http://console:8080', token: 'jwt' }))
      .rejects.toThrow('web-console 不可达')
  })
})

describe('buildEnterpriseProfiles', () => {
  const DEFAULTS = { contextWindow: 262_144, maxTokens: 32_768 }

  it('空清单:空 profile 集(休眠)', () => {
    expect(buildEnterpriseProfiles([], 'http://console:8080', DEFAULTS).size).toBe(0)
  })

  it('非空:单路由,容量缺省回落默认值;reasoning 模型声明推理档位,imageInput 模型声明图片模态', () => {
    const profiles = buildEnterpriseProfiles([
      { gatewayModelName: 'enterprise-chat', displayName: '企业对话', contextWindow: 128_000, maxTokens: 8_192, reasoning: false, imageInput: false },
      { gatewayModelName: 'enterprise-reasoner', displayName: '企业推理', contextWindow: undefined, maxTokens: undefined, reasoning: true, imageInput: true },
    ], 'http://console:8080', DEFAULTS)
    expect([...profiles.keys()]).toEqual([ENTERPRISE_PROVIDER])
    const profile = profiles.get(ENTERPRISE_PROVIDER)
    expect(profile?.displayName).toBe('企业模型')
    const models = profile?.piProvider?.getModels() ?? []
    expect(models.map(model => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }))).toEqual([
      { id: 'enterprise-chat', name: '企业对话', contextWindow: 128_000, maxTokens: 8_192 },
      { id: 'enterprise-reasoner', name: '企业推理', contextWindow: 262_144, maxTokens: 32_768 },
    ])
    // 推理能力:reasoning 模型的能力标志为 true 且 thinkingLevelMap 中声明的档位
    // 带有效 wire 拼写(未声明档位为 null,选择器投影过滤)——普通模型两者皆无
    expect(models[0]?.reasoning).toBe(false)
    expect(models[1]?.reasoning).toBe(true)
    const levelMap = models[1]?.thinkingLevelMap ?? {}
    const offered = Object.entries(levelMap).filter(([, wire]) => wire != null).map(([level]) => level)
    expect(offered).toEqual(['low', 'medium', 'high'])
    // 图片能力:imageInput 模型声明 text+image 模态(发消息允许附带图片),
    // 普通模型未声明 input,resolveProfiles 填充默认纯文本(附带图片被拒)
    expect(models[0]?.input).toEqual(['text'])
    expect(models[1]?.input).toEqual(['text', 'image'])
  })
})

describe('mapEnterpriseFailure', () => {
  it('已知网关错误码:映射为固定文案与可路由码,带 HTTP 状态', () => {
    const failure = Object.freeze({
      message: '409: {"success":false,"data":null,"error":{"code":"LLM_QUOTA_EXHAUSTED","message":"本月所有额度池额度均不足"}}',
      code: 'PI_AI_ERROR',
    })
    expect(mapEnterpriseFailure(failure)).toEqual({
      message: '企业模型本月额度已用完,请联系管理员调整额度,或切换其他模型',
      code: 'LLM_QUOTA_EXHAUSTED',
      status: 409,
    })
  })

  it('未知网关错误码:保留服务端消息,码替换为网关码', () => {
    const failure = Object.freeze({
      message: '502: {"success":false,"error":{"code":"LLM_NEWAPI_UNAVAILABLE","message":"New API 调用失败"}}',
      code: 'PI_AI_ERROR',
    })
    expect(mapEnterpriseFailure(failure)).toEqual({
      message: 'New API 调用失败',
      code: 'LLM_NEWAPI_UNAVAILABLE',
      status: 502,
    })
  })

  it('401 未带信封:映射为重新登录提示,码 AUTH', () => {
    const failure = Object.freeze({ message: '401 status code (no body)', code: 'AUTH' })
    expect(mapEnterpriseFailure(failure)).toEqual({
      message: '企业登录已过期或未登录,请重新登录后重试',
      code: 'AUTH',
      status: 401,
    })
  })

  it('普通失败:原样返回(同一引用)', () => {
    const failure = Object.freeze({ message: 'pi-ai stream idle timeout', code: 'TIMEOUT' })
    expect(mapEnterpriseFailure(failure)).toBe(failure)
  })
})

describe('llm-access 生命周期', () => {
  let ctx: Context

  beforeEach(() => {
    ctx = new Context()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const mount = (token: string | undefined, data: () => unknown) => {
    const fetchMock = vi.fn(async (input: URL | string) => {
      void input
      return jsonResponse(200, { success: true, data: data() })
    })
    vi.stubGlobal('fetch', fetchMock)
    const llm = stubLlm()
    ctx.provide('llm', llm as never)
    ctx.provide('currentUser', stubCurrentUser(token))
    apply(ctx, { ...CONFIG })
    return { llm, fetchMock }
  }

  it('挂载时已登录:拉取目录并注册路由', async () => {
    const { llm, fetchMock } = mount('jwt-1', () => MODELS_V1)
    await vi.waitFor(() => { expect(llm.calls).toEqual([{ kind: 'register', routes: ['llm-enterprise'] }]) })
    expect(fetchMock.mock.calls[0]?.[0]).toBeInstanceOf(URL)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://console:8080/api/llm/models')
  })

  it('挂载时未登录:不拉取不注册,verified 事件后注册', async () => {
    const { llm, fetchMock } = mount(undefined, () => MODELS_V1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(llm.calls).toEqual([])
    ctx.emit('platform-user/verified', platformUser(), 'jwt-1')
    await vi.waitFor(() => { expect(llm.calls).toEqual([{ kind: 'register', routes: ['llm-enterprise'] }]) })
  })

  it('清单未变:重复刷新不触发额外注册调用;清单变化:原位 replace;清空:replace([]) 撤出', async () => {
    let payload: unknown = MODELS_V1
    const { llm, fetchMock } = mount('jwt-1', () => payload)
    await vi.waitFor(() => { expect(llm.calls).toHaveLength(1) })

    // 同一清单:拉取发生但跳过 replace(等第二次 fetch 完成后再断言)
    ctx.emit('platform-user/verified', platformUser(), 'jwt-2')
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(llm.calls).toEqual([{ kind: 'register', routes: ['llm-enterprise'] }])

    // 清单变化:replace 触发 llm/adapters-updated,选择器重读目录
    payload = MODELS_V2
    ctx.emit('platform-user/verified', platformUser(), 'jwt-3')
    await vi.waitFor(() => { expect(llm.calls).toHaveLength(2) })
    expect(llm.calls[1]).toEqual({ kind: 'replace', routes: ['llm-enterprise'] })

    // 清单清空:撤出分组,注册句柄保留
    payload = []
    ctx.emit('platform-user/verified', platformUser(), 'jwt-4')
    await vi.waitFor(() => { expect(llm.calls).toHaveLength(3) })
    expect(llm.calls[2]).toEqual({ kind: 'replace', routes: [] })
  })

  it('登出:清空目录并撤出路由', async () => {
    const { llm } = mount('jwt-1', () => MODELS_V1)
    await vi.waitFor(() => { expect(llm.calls).toHaveLength(1) })
    ctx.emit('platform-user/signout')
    expect(llm.calls[1]).toEqual({ kind: 'replace', routes: [] })
  })
})
