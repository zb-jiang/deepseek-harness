/** 工作台纯函数层单测:JSON 提取、映射构建、活动状态归并。 */
import { describe, expect, it } from 'vitest'
import type { ConversationNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { HistoricActivity } from '../task-api.ts'
import {
  activityStatuses, buildVariables, collectJsonBlocks, defaultMappings, executionRecords,
  extractJson, latestJson, targetOptions,
} from './pure.ts'

function assistantNode(text: string): ConversationNode {
  return {
    kind: 'assistant', seq: 1, time: 0, turn: 1, step: 1,
    blocks: [{ kind: 'text', text }],
  }
}

describe('latestJson', () => {
  it('scans backwards past plain-text replies to the latest JSON', () => {
    const nodes: ConversationNode[] = [
      assistantNode('结果\n```json\n{"a":1}\n```'),
      { kind: 'user', seq: 2, time: 0, content: [], source: null },
      assistantNode('补充说明,没有 JSON'),
    ]
    expect(latestJson(nodes)).toEqual({ a: 1 })
  })

  it('prefers the newest JSON when several assistant messages carry one', () => {
    const nodes: ConversationNode[] = [
      assistantNode('```json\n{"first":1}\n```'),
      assistantNode('```json\n{"second":2}\n```'),
    ]
    expect(latestJson(nodes)).toEqual({ second: 2 })
  })

  it('skips reasoning and tool-call blocks', () => {
    const nodes: ConversationNode[] = [{
      kind: 'assistant', seq: 3, time: 0, turn: 1, step: 1,
      blocks: [
        { kind: 'reasoning', text: '思考 {"x":1}' },
        { kind: 'text', text: '结论 {"y":2}' },
      ],
    }]
    expect(latestJson(nodes)).toEqual({ y: 2 })
  })

  it('returns undefined without any JSON in the conversation', () => {
    expect(latestJson([])).toBeUndefined()
    expect(latestJson([{ kind: 'user', seq: 1, time: 0, content: [], source: null }])).toBeUndefined()
    expect(latestJson([assistantNode('纯文本没有结构')])).toBeUndefined()
  })
})

describe('collectJsonBlocks', () => {
  it('collects every JSON block with its reply number in order', () => {
    const nodes: ConversationNode[] = [
      assistantNode('结果\n```json\n{"a":1}\n```'),
      { kind: 'user', seq: 2, time: 0, content: [], source: null },
      assistantNode('第二轮 {"b":2} 完成'),
    ]
    expect(collectJsonBlocks(nodes)).toEqual([
      { messageNo: 1, preview: '{"a":1}', value: { a: 1 } },
      { messageNo: 2, preview: '{"b":2}', value: { b: 2 } },
    ])
  })

  it('numbers blocks by assistant replies, skipping JSON-less ones', () => {
    const nodes: ConversationNode[] = [
      assistantNode('先聊两句,没有 JSON'),
      assistantNode('```json\n[1, 2]\n```'),
    ]
    expect(collectJsonBlocks(nodes)).toEqual([
      { messageNo: 2, preview: '[1,2]', value: [1, 2] },
    ])
  })

  it('returns empty without any JSON', () => {
    expect(collectJsonBlocks([])).toEqual([])
  })
})

describe('extractJson', () => {
  it('prefers the last fenced block', () => {
    const text = '说明\n```json\n{"a":1}\n```\n中间\n```\n{"b":2}\n```'
    expect(extractJson(text)).toEqual({ b: 2 })
  })

  it('parses a fenced block without language tag', () => {
    expect(extractJson('结果:\n```\n[1, 2]\n```')).toEqual([1, 2])
  })

  it('falls back to the first balanced object', () => {
    expect(extractJson('输出 {"x": {"y": 1}} 完成')).toEqual({ x: { y: 1 } })
  })

  it('tracks braces inside strings', () => {
    expect(extractJson('{"s": "a}b{c"}')).toEqual({ s: 'a}b{c' })
  })

  it('handles escaped quotes in strings', () => {
    expect(extractJson('前缀 {"s": "he said \\"hi {there\\""} 后缀')).toEqual({ s: 'he said "hi {there"' })
  })

  it('returns undefined on absent or invalid JSON', () => {
    expect(extractJson(null)).toBeUndefined()
    expect(extractJson('')).toBeUndefined()
    expect(extractJson('纯文本没有结构')).toBeUndefined()
    expect(extractJson('```json\n{broken\n```')).toBeUndefined()
    expect(extractJson('{ 未闭合')).toBeUndefined()
  })
})

describe('defaultMappings', () => {
  it('keeps rows with a non-empty target and defaults source', () => {
    expect(defaultMappings([
      { source: 'a.b', target: 'result' },
      { source: 'c', target: null },
      { source: null, target: 'score' },
    ])).toEqual([
      { source: 'a.b', target: 'result' },
      { source: '', target: 'score' },
    ])
  })

  it('returns empty for null input', () => {
    expect(defaultMappings(null)).toEqual([])
    expect(defaultMappings(undefined)).toEqual([])
  })
})

describe('targetOptions', () => {
  it('walks nested object fields', () => {
    expect(targetOptions([
      {
        name: 'result', type: 'object', description: null, initialValue: null,
        itemType: null, source: null,
        fields: [
          { name: 'score', type: 'number', description: null, fields: null },
          { name: 'meta', type: 'object', description: null, fields: [
            { name: 'note', type: 'string', description: null, fields: null },
          ] },
        ],
      },
      { name: 'count', type: 'number', description: null, initialValue: null, itemType: null, source: null, fields: null },
    ])).toEqual([
      { value: 'result', label: 'result (object)' },
      { value: 'result.score', label: 'result.score (number)' },
      { value: 'result.meta', label: 'result.meta (object)' },
      { value: 'result.meta.note', label: 'result.meta.note (string)' },
      { value: 'count', label: 'count (number)' },
    ])
  })
})

describe('buildVariables', () => {
  const variables = [
    {
      name: 'result', type: 'object', description: null, initialValue: null,
      itemType: null, source: null,
      fields: [{ name: 'score', type: 'number', description: null, fields: null }],
    },
  ]

  it('maps source paths onto nested target paths', () => {
    expect(buildVariables(
      { data: { score: 9 } },
      [{ source: 'data.score', target: 'result.score' }],
      variables,
    )).toEqual({ result: { score: 9 } })
  })

  it('empty source maps the whole JSON document', () => {
    expect(buildVariables(
      { score: 1 },
      [{ source: '', target: 'result' }],
      variables,
    )).toEqual({ result: { score: 1 } })
  })

  it('missing source path writes an undefined leaf', () => {
    const out = buildVariables(
      { other: 1 },
      [{ source: 'data.score', target: 'result.score' }],
      variables,
    ) as { result: Record<string, unknown> }
    expect('score' in out.result).toBe(true)
    expect(out.result.score).toBeUndefined()
  })

  it('skips rows without target', () => {
    expect(buildVariables({ a: 1 }, [{ source: 'a', target: '' }], variables)).toEqual({})
  })

  it('throws when the target root is undeclared', () => {
    expect(() => buildVariables(
      { a: 1 },
      [{ source: 'a', target: 'ghost.x' }],
      variables,
    )).toThrow('变量 ghost 未在流程上下文声明中定义')
  })
})

describe('activityStatuses', () => {
  function activity(activityId: string, endTime: string | null, type = 'userTask'): HistoricActivity {
    return {
      id: `${activityId}-${endTime ?? 'open'}`, processInstanceId: 'p', processDefinitionId: 'd',
      activityId, activityName: activityId, activityType: type, assignee: null,
      startTime: '2026-01-01T00:00:00Z', endTime, durationInMillis: null,
    }
  }

  it('unfinished occurrence wins (parallel multi-instance)', () => {
    expect(activityStatuses([
      activity('approve', '2026-01-01T00:01:00Z'),
      activity('approve', null),
    ]).get('approve')).toBe('active')
  })

  it('all ended is done; sequence flows join the table', () => {
    const statuses = activityStatuses([
      activity('flow1', '2026-01-01T00:00:01Z', 'sequenceFlow'),
      activity('start1', '2026-01-01T00:00:00Z', 'startEvent'),
    ])
    expect(statuses.get('flow1')).toBe('done')
    expect(statuses.get('start1')).toBe('done')
  })

  it('loop re-entry after completion flips back to active', () => {
    expect(activityStatuses([
      activity('fix', '2026-01-01T00:01:00Z'),
      activity('fix', null),
    ]).get('fix')).toBe('active')
  })
})

describe('executionRecords', () => {
  function activity(activityId: string, startTime: string, type = 'userTask'): HistoricActivity {
    return {
      id: activityId, processInstanceId: 'p', processDefinitionId: 'd',
      activityId, activityName: activityId, activityType: type, assignee: null,
      startTime, endTime: null, durationInMillis: null,
    }
  }

  it('drops sequence flows and orders by start time', () => {
    expect(executionRecords([
      activity('b', '2026-01-01T00:02:00Z'),
      activity('flow', '2026-01-01T00:00:30Z', 'sequenceFlow'),
      activity('a', '2026-01-01T00:01:00Z'),
    ]).map(a => a.activityId)).toEqual(['a', 'b'])
  })

  it('null startTime sorts last', () => {
    expect(executionRecords([
      activity('noTime', '2026-01-01T00:00:00Z'),
      activity('later', '2026-01-02T00:00:00Z'),
    ]).map(a => a.activityId)).toEqual(['noTime', 'later'])
  })
})
