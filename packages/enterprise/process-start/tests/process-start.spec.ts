import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CurrentUserService } from '@deepseek-ai/dsh-user-identity-context'
import * as processStart from '../src/index.ts'

const { apply } = processStart

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

/** 按 URL 分发的 fetch 桩;response 抛错即网络失败。 */
function stubFetch(routes: { match: (url: string) => boolean; response: () => Response }[]) {
  return vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
    const url = String(input)
    for (const route of routes) {
      if (route.match(url)) return route.response()
    }
    return jsonResponse(404, { error: `unexpected fetch ${url}` })
  })
}

const CONFIG = {
  // 尾斜杠覆盖 apply 的去尾逻辑;断言里的上游地址是无尾斜杠形态。
  webConsoleBaseUrl: 'http://console:8080/',
}

/** 合法 UUID 形态(既有用例走「UUID 透传」路径,不触发名称解析)。 */
const W1_ID = '11111111-1111-4111-8111-111111111111'
const W2_ID = '22222222-2222-4222-8222-222222222222'

const STARTABLE = [
  {
    id: W1_ID,
    name: '报销流程',
    description: '员工差旅报销',
    bpmnProcessKey: 'expenseOrgRouting',
    appId: 'app1',
    appName: '财务应用',
  },
  {
    id: W2_ID,
    name: '采购流程',
    description: null,
    bpmnProcessKey: 'purchaseOrgRouting',
    appId: 'app1',
    appName: '财务应用',
  },
]

describe('process-start', () => {
  let ctx: Context

  const mount = (token: string | undefined, fetchMock: ReturnType<typeof stubFetch> = stubFetch([])) => {
    vi.stubGlobal('fetch', fetchMock)
    const tools = stubTools()
    ctx.provide('tools', tools as never)
    ctx.provide('currentUser', stubCurrentUser(token) as never)
    apply(ctx, { ...CONFIG })
    return { tools, fetchMock }
  }

  const toolOf = (tools: ReturnType<typeof stubTools>, toolName: string): StubTool => {
    const found = tools.registered.find(candidate => candidate.name === toolName)
    if (found === undefined) throw new Error(`tool ${toolName} not registered`)
    return found
  }

  const execute = (tool: StubTool, args: unknown) =>
    tool.execute(args as never, { signal: new AbortController().signal } as never)

  beforeEach(() => {
    ctx = new Context()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('apply 注册三个流程工具', () => {
    const { tools } = mount('jwt')
    expect(tools.registered.map(tool => tool.name).sort()).toEqual([
      'dsh_process_list',
      'dsh_process_start',
      'dsh_process_start_form',
    ])
  })

  it('apply 校验配置:非法 baseUrl 立即抛错(misconfiguration fails loud)', () => {
    vi.stubGlobal('fetch', stubFetch([]))
    ctx.provide('tools', stubTools() as never)
    ctx.provide('currentUser', stubCurrentUser('jwt') as never)
    expect(() => apply(ctx, { ...CONFIG, webConsoleBaseUrl: 'not-a-url' })).toThrow()
  })

  it('dsh_process_list:映射 appName 与 description,null 说明省略,render/presentCall 可用', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/process-instances/startable',
      response: () => jsonResponse(200, { success: true, data: STARTABLE }),
    }])
    const { tools } = mount('jwt', fetchMock)
    const list = toolOf(tools, 'dsh_process_list')
    const result = await execute(list, {}) as {
      workflows: { id: string; name: string; appName: string; description?: string }[]
    }
    expect(result.workflows).toEqual([
      { id: W1_ID, name: '报销流程', appName: '财务应用', description: '员工差旅报销' },
      { id: W2_ID, name: '采购流程', appName: '财务应用' },
    ])
    expect(list.output.render(undefined as never, result as never)).toEqual([
      {
        type: 'text',
        text: `可发起流程 2 个:\n- 报销流程 (id: ${W1_ID}, 应用: 财务应用)\n  说明: 员工差旅报销\n- 采购流程 (id: ${W2_ID}, 应用: 财务应用)`,
      },
    ])
    expect(list.presentCall({} as never)).toEqual({ card: 'generic', title: '列可发起流程', kind: 'fetch' })
  })

  it('dsh_process_list:无流程时 render 提示为空', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => jsonResponse(200, { success: true, data: [] }),
    }])
    const { tools } = mount('jwt', fetchMock)
    const list = toolOf(tools, 'dsh_process_list')
    const result = await execute(list, {}) as { workflows: unknown[] }
    expect(result.workflows).toEqual([])
    expect(list.output.render(undefined as never, result as never)).toEqual([
      { type: 'text', text: '当前没有你可发起的流程。' },
    ])
  })

  it('dsh_process_start_form:按 workflowDefinitionId 查询并映射声明,render/presentCall 可用', async () => {
    const fetchMock = stubFetch([{
      match: url => url === `http://console:8080/api/process-instances/start-form?workflowDefinitionId=${W1_ID}`,
      response: () => jsonResponse(200, {
        success: true,
        data: [
          { name: 'amount', type: 'float', description: '报销金额', required: true },
          { name: 'reason', type: 'string', description: null, required: false },
        ],
      }),
    }])
    const { tools, fetchMock: fetchRef } = mount('jwt', fetchMock)
    const form = toolOf(tools, 'dsh_process_start_form')
    const result = await execute(form, { workflowDefinitionId: W1_ID }) as {
      variables: { name: string; type: string; required: boolean; description?: string }[]
    }
    expect(result.variables).toEqual([
      { name: 'amount', type: 'float', required: true, description: '报销金额' },
      { name: 'reason', type: 'string', required: false },
    ])
    expect(form.output.render(undefined as never, result as never)).toEqual([
      {
        type: 'text',
        text: '流程启动参数 2 个:\n- amount(float,必填) 报销金额\n- reason(string)',
      },
    ])
    expect(form.presentCall({ workflowDefinitionId: W1_ID } as never)).toEqual({
      card: 'generic', title: '读流程启动参数', kind: 'read', rawInput: W1_ID,
    })
    expect(fetchRef).toHaveBeenCalledTimes(1)
  })

  it('dsh_process_start_form:无声明时 render 提示可直接发起', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => jsonResponse(200, { success: true, data: [] }),
    }])
    const { tools } = mount('jwt', fetchMock)
    const form = toolOf(tools, 'dsh_process_start_form')
    const result = await execute(form, { workflowDefinitionId: W1_ID }) as { variables: unknown[] }
    expect(result.variables).toEqual([])
    expect(form.output.render(undefined as never, result as never)).toEqual([
      { type: 'text', text: '该流程没有启动参数声明,可直接发起。' },
    ])
  })

  it('dsh_process_start:POST 请求体按可选字段组装,返回实例展示字段,render/presentCall 可用', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/process-instances',
      response: () => jsonResponse(200, {
        success: true,
        data: {
          id: 'inst-1',
          name: '张三的报销',
          workflowName: '报销流程',
          startTime: '2026-09-20T10:00:00+08:00',
        },
      }),
    }])
    const { tools, fetchMock: fetchRef } = mount('jwt', fetchMock)
    const start = toolOf(tools, 'dsh_process_start')
    const result = await execute(start, {
      workflowDefinitionId: W1_ID,
      orgUnitId: 'unit-a',
      variables: { amount: 1200.5 },
      name: '张三的报销',
    }) as { instanceId: string; startTime: string; name?: string; workflowName?: string }
    expect(result).toEqual({
      instanceId: 'inst-1',
      startTime: '2026-09-20T10:00:00+08:00',
      name: '张三的报销',
      workflowName: '报销流程',
    })
    const [input, init] = fetchRef.mock.calls[0]!
    expect(String(input)).toBe('http://console:8080/api/process-instances')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({
      authorization: 'Bearer jwt',
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      workflowDefinitionId: W1_ID,
      orgUnitId: 'unit-a',
      variables: { amount: 1200.5 },
      name: '张三的报销',
    })
    expect(start.output.render(undefined as never, result as never)).toEqual([
      { type: 'text', text: '流程实例已发起(实例 id: inst-1,实例名: 张三的报销,流程: 报销流程)。' },
    ])
    expect(start.presentCall({ workflowDefinitionId: W1_ID, name: '张三的报销' } as never)).toEqual({
      card: 'generic', title: '发起流程', kind: 'execute', rawInput: '张三的报销',
    })
  })

  it('dsh_process_start:可选字段缺省时请求体只含 workflowDefinitionId,实例空字段省略', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => jsonResponse(200, {
        success: true,
        data: { id: 'inst-2', name: null, workflowName: null, startTime: '2026-09-20T10:00:00+08:00' },
      }),
    }])
    const { tools, fetchMock: fetchRef } = mount('jwt', fetchMock)
    const start = toolOf(tools, 'dsh_process_start')
    const result = await execute(start, { workflowDefinitionId: W2_ID }) as Record<string, unknown>
    expect(result).toEqual({ instanceId: 'inst-2', startTime: '2026-09-20T10:00:00+08:00' })
    expect(JSON.parse(String(fetchRef.mock.calls[0]![1]?.body))).toEqual({ workflowDefinitionId: W2_ID })
    expect(start.output.render(undefined as never, result as never)).toEqual([
      { type: 'text', text: '流程实例已发起(实例 id: inst-2)。' },
    ])
    expect(start.presentCall({ workflowDefinitionId: W2_ID } as never)).toEqual({
      card: 'generic', title: '发起流程', kind: 'execute', rawInput: W2_ID,
    })
  })

  it('dsh_process_start_form:传流程名称时自动解析为 UUID(唯一命中)', async () => {
    const fetchMock = stubFetch([
      {
        match: url => url === 'http://console:8080/api/process-instances/startable',
        response: () => jsonResponse(200, { success: true, data: STARTABLE }),
      },
      {
        match: url => url === `http://console:8080/api/process-instances/start-form?workflowDefinitionId=${W1_ID}`,
        response: () => jsonResponse(200, {
          success: true,
          data: [{ name: 'expenseId', type: 'string', description: null, required: true }],
        }),
      },
    ])
    const { tools, fetchMock: fetchRef } = mount('jwt', fetchMock)
    const form = toolOf(tools, 'dsh_process_start_form')
    const result = await execute(form, { workflowDefinitionId: '报销流程' }) as { variables: unknown[] }
    expect(result.variables).toEqual([{ name: 'expenseId', type: 'string', required: true }])
    // 第 1 次:startable 解析;第 2 次:用解析出的 UUID 查启动参数
    expect(fetchRef).toHaveBeenCalledTimes(2)
  })

  it('dsh_process_start:传 BPMN key 时自动解析为 UUID 后发起', async () => {
    const fetchMock = stubFetch([
      {
        match: url => url === 'http://console:8080/api/process-instances/startable',
        response: () => jsonResponse(200, { success: true, data: STARTABLE }),
      },
      {
        match: url => url === 'http://console:8080/api/process-instances',
        response: () => jsonResponse(200, {
          success: true,
          data: { id: 'inst-3', name: null, workflowName: '报销流程', startTime: '2026-09-24T10:00:00+08:00' },
        }),
      },
    ])
    const { tools, fetchMock: fetchRef } = mount('jwt', fetchMock)
    const start = toolOf(tools, 'dsh_process_start')
    const result = await execute(start, { workflowDefinitionId: 'expenseOrgRouting' }) as Record<string, unknown>
    expect(result).toEqual({
      instanceId: 'inst-3',
      startTime: '2026-09-24T10:00:00+08:00',
      workflowName: '报销流程',
    })
    // POST 请求体里是解析后的 UUID,不是原始 key
    expect(JSON.parse(String(fetchRef.mock.calls[1]![1]?.body))).toEqual({ workflowDefinitionId: W1_ID })
  })

  it('解析:模糊匹配到多个流程时报错并列出候选', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/process-instances/startable',
      response: () => jsonResponse(200, { success: true, data: STARTABLE }),
    }])
    const { tools } = mount('jwt', fetchMock)
    await expect(execute(toolOf(tools, 'dsh_process_start'), { workflowDefinitionId: '流程' }))
      .rejects.toThrow('匹配到 2 个流程')
  })

  it('解析:无匹配时报错并附可发起清单', async () => {
    const fetchMock = stubFetch([{
      match: url => url === 'http://console:8080/api/process-instances/startable',
      response: () => jsonResponse(200, { success: true, data: STARTABLE }),
    }])
    const { tools } = mount('jwt', fetchMock)
    await expect(execute(toolOf(tools, 'dsh_process_start'), { workflowDefinitionId: '不存在' }))
      .rejects.toThrow('没有找到匹配 "不存在" 的可发起流程')
  })

  it('未登录时抛错', async () => {
    const { tools } = mount(undefined)
    await expect(execute(toolOf(tools, 'dsh_process_list'), {})).rejects.toThrow('未登录')
    await expect(execute(toolOf(tools, 'dsh_process_start'), { workflowDefinitionId: W1_ID })).rejects.toThrow('未登录')
  })

  it('web-console 不可达时抛 502 消息', async () => {
    const fetchMock = stubFetch([{ match: () => true, response: () => { throw new Error('ECONNREFUSED') } }])
    const { tools } = mount('jwt', fetchMock)
    await expect(execute(toolOf(tools, 'dsh_process_list'), {})).rejects.toThrow('web-console 不可达')
  })

  it('fetch 抛非 Error 值时同样抛 502 消息', async () => {
    const fetchMock = stubFetch([{ match: () => true, response: () => { throw 'boom' } }])
    const { tools } = mount('jwt', fetchMock)
    await expect(execute(toolOf(tools, 'dsh_process_start'), { workflowDefinitionId: W1_ID })).rejects.toThrow('boom')
  })

  it('响应非 JSON 时抛错', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => new Response('<html>oops</html>', { headers: { 'content-type': 'text/html' } }),
    }])
    const { tools } = mount('jwt', fetchMock)
    await expect(execute(toolOf(tools, 'dsh_process_start_form'), { workflowDefinitionId: W1_ID })).rejects.toThrow('不是 JSON')
  })

  it('信封失败时透出上游错误消息', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => jsonResponse(401, { success: false, error: { message: 'token 过期' } }),
    }])
    const { tools } = mount('jwt', fetchMock)
    await expect(execute(toolOf(tools, 'dsh_process_list'), {})).rejects.toThrow('token 过期')
  })

  it('信封无 data 且无错误消息时抛未知错误', async () => {
    const fetchMock = stubFetch([{
      match: () => true,
      response: () => jsonResponse(200, { success: true }),
    }])
    const { tools } = mount('jwt', fetchMock)
    await expect(execute(toolOf(tools, 'dsh_process_list'), {})).rejects.toThrow('未知错误')
  })
})
