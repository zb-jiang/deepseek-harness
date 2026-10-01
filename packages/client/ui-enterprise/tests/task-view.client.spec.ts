import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  completedTaskRow, deriveTaskGroups, DEFAULT_TASK_VIEW_OPTIONS, loadTaskViewState,
  pendingTaskRow, saveTaskViewState,
} from '../src/client/task-view.ts'
import type { CompletedTask, Task } from '../src/client/task-api.ts'

/** 与实现同口径的本地时区日期键,保证断言在任意 CI 时区下稳定。 */
function expectedDateKey(iso: string): string {
  const date = new Date(Date.parse(iso))
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function pendingTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    processInstanceId: 'pi-1',
    processDefinitionId: 'expense_flow:3:uuid-1',
    taskDefinitionKey: 'node-1',
    name: null,
    assignee: null,
    createTime: '2026-09-30T08:00:00Z',
    dshMeta: null,
    nodeId: null,
    processDefinitionName: null,
    startUserId: null,
    startUserName: null,
    applicationId: null,
    ...overrides,
  }
}

function completedTask(overrides: Partial<CompletedTask> & { id: string }): CompletedTask {
  return {
    processInstanceId: 'pi-1',
    processDefinitionId: 'expense_flow:3:uuid-1',
    processDefinitionName: null,
    taskDefinitionKey: 'node-1',
    name: null,
    assignee: null,
    startTime: '2026-09-30T08:00:00Z',
    endTime: '2026-09-30T09:00:00Z',
    durationInMillis: null,
    deleteReason: null,
    dshMeta: null,
    nodeId: null,
    ...overrides,
  }
}

describe('pendingTaskRow / completedTaskRow', () => {
  it('prefers the task name and process definition name when present', () => {
    const row = pendingTaskRow(pendingTask({
      id: 't-1',
      name: '部门审批',
      processDefinitionName: '报销审批',
    }))
    expect(row.title).toBe('部门审批')
    expect(row.processLabel).toBe('报销审批')
    expect(row.timeMs).toBe(Date.parse('2026-09-30T08:00:00Z'))
    // 绝对短时间格式(时区由运行环境决定,只断言 MM-DD HH:mm 形状)。
    expect(row.timeLabel).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('falls back to the definition key segment and the task id', () => {
    const row = pendingTaskRow(pendingTask({ id: 't-2', processDefinitionId: 'leave_flow:1:uuid-2' }))
    expect(row.title).toBe('t-2')
    expect(row.processLabel).toBe('leave_flow')
  })

  it('maps a missing end time to null sort key and empty label', () => {
    const row = completedTaskRow(completedTask({ id: 't-3', endTime: null }))
    expect(row.timeMs).toBeNull()
    expect(row.timeLabel).toBe('')
  })

  it('prefers the process definition name for completed rows, key segment as fallback', () => {
    const named = completedTaskRow(completedTask({ id: 't-4', processDefinitionName: '报销审批' }))
    expect(named.processLabel).toBe('报销审批')
    const unnamed = completedTaskRow(completedTask({ id: 't-5' }))
    expect(unnamed.processLabel).toBe('expense_flow')
  })
})

describe('deriveTaskGroups', () => {
  it('groups by date and sorts titles ascending inside groups, dates descending across groups', () => {
    const tasks = [
      pendingTask({ id: 'a', name: 'C 任务', createTime: '2026-03-15T08:00:00Z' }),
      pendingTask({ id: 'b', name: 'A 任务', createTime: '2026-03-15T09:00:00Z' }),
      pendingTask({ id: 'c', name: 'B 任务', createTime: '2026-01-01T08:00:00Z' }),
    ]
    const groups = deriveTaskGroups(tasks, { groupBy: 'date', orderBy: 'asc' }, pendingTaskRow)
    const marchKey = expectedDateKey('2026-03-15T08:00:00Z')
    const januaryKey = expectedDateKey('2026-01-01T08:00:00Z')
    expect(groups.map(g => g.key)).toEqual([januaryKey, marchKey])
    const march = groups.find(g => g.key === marchKey)
    if (march === undefined) throw new Error('march group missing')
    expect(march.rows.map(r => r.row.title)).toEqual(['A 任务', 'C 任务'])
  })

  it('flips both group order and title order when descending (date mode)', () => {
    const tasks = [
      pendingTask({ id: 'a', name: 'A 任务', createTime: '2026-03-15T08:00:00Z' }),
      pendingTask({ id: 'b', name: 'B 任务', createTime: '2026-01-01T08:00:00Z' }),
    ]
    const groups = deriveTaskGroups(tasks, { groupBy: 'date', orderBy: 'desc' }, pendingTaskRow)
    const marchKey = expectedDateKey('2026-03-15T08:00:00Z')
    const januaryKey = expectedDateKey('2026-01-01T08:00:00Z')
    expect(groups.map(g => g.key)).toEqual([marchKey, januaryKey])
    const march = groups.at(0)
    const january = groups.at(1)
    if (march === undefined || january === undefined) throw new Error('expected two groups')
    expect(march.rows.map(r => r.row.title)).toEqual(['A 任务'])
    expect(january.rows.map(r => r.row.title)).toEqual(['B 任务'])
  })

  it('groups by process type and sorts by time inside groups, labels ascending across groups', () => {
    const tasks = [
      pendingTask({ id: 'old', name: '旧任务', createTime: '2026-01-01T08:00:00Z', processDefinitionName: '报销审批' }),
      pendingTask({ id: 'new', name: '新任务', createTime: '2026-06-01T08:00:00Z', processDefinitionName: '报销审批' }),
      pendingTask({ id: 'x', name: '请假', createTime: '2026-02-01T08:00:00Z', processDefinitionName: '请假流程' }),
    ]
    const groups = deriveTaskGroups(tasks, { groupBy: 'processType', orderBy: 'asc' }, pendingTaskRow)
    // 拼音序:报(bǎo) < 请(qǐng)。
    expect(groups.map(g => g.label)).toEqual(['报销审批', '请假流程'])
    const expense = groups.find(g => g.label === '报销审批')
    if (expense === undefined) throw new Error('报销审批 group missing')
    expect(expense.rows.map(r => r.item.id)).toEqual(['old', 'new'])
  })

  it('sorts newest-first inside process groups and labels descending across groups', () => {
    const tasks = [
      pendingTask({ id: 'old', name: '旧任务', createTime: '2026-01-01T08:00:00Z', processDefinitionName: '报销审批' }),
      pendingTask({ id: 'new', name: '新任务', createTime: '2026-06-01T08:00:00Z', processDefinitionName: '报销审批' }),
      pendingTask({ id: 'x', name: '请假', createTime: '2026-02-01T08:00:00Z', processDefinitionName: '请假流程' }),
    ]
    const groups = deriveTaskGroups(tasks, { groupBy: 'processType', orderBy: 'desc' }, pendingTaskRow)
    // 拼音序降序:请(qǐng) > 报(bǎo)。
    expect(groups.map(g => g.label)).toEqual(['请假流程', '报销审批'])
    const expense = groups.find(g => g.label === '报销审批')
    if (expense === undefined) throw new Error('报销审批 group missing')
    expect(expense.rows.map(r => r.item.id)).toEqual(['new', 'old'])
  })

  it('puts unparseable times last inside time-ordered groups and in a trailing 未知时间 group', () => {
    const tasks = [
      pendingTask({ id: 'bad', name: '坏时间', createTime: 'not-a-date' }),
      pendingTask({ id: 'good', name: '好时间', createTime: '2026-01-01T08:00:00Z' }),
    ]
    const byTime = deriveTaskGroups(tasks, { groupBy: 'processType', orderBy: 'asc' }, pendingTaskRow)
    const timeGroup = byTime.at(0)
    if (timeGroup === undefined) throw new Error('expected one process group')
    expect(timeGroup.rows.map(r => r.item.id)).toEqual(['good', 'bad'])

    const byDate = deriveTaskGroups(tasks, { groupBy: 'date', orderBy: 'asc' }, pendingTaskRow)
    expect(byDate.map(g => g.key)).toEqual([expectedDateKey('2026-01-01T08:00:00Z'), 'unknown'])
    const datedGroup = byDate.at(0)
    if (datedGroup === undefined) throw new Error('expected a dated group')
    expect(datedGroup.rows.map(r => r.item.id)).toEqual(['good'])
  })
})

describe('task view persistence', () => {
  let storage: Map<string, string>

  beforeEach(() => {
    storage = new Map()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value) },
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('round-trips both lists\' options through localStorage', () => {
    const state = loadTaskViewState()
    expect(state).toEqual({
      pending: DEFAULT_TASK_VIEW_OPTIONS,
      completed: DEFAULT_TASK_VIEW_OPTIONS,
    })
    saveTaskViewState({ pending: { groupBy: 'processType', orderBy: 'asc' }, completed: state.completed })
    expect(loadTaskViewState()).toEqual({
      pending: { groupBy: 'processType', orderBy: 'asc' },
      completed: DEFAULT_TASK_VIEW_OPTIONS,
    })
  })

  it('falls back field-by-field on corrupted entries and invalid values', () => {
    storage.set('dsh-enterprise-task-view-options', '{broken json')
    expect(loadTaskViewState()).toEqual({
      pending: DEFAULT_TASK_VIEW_OPTIONS,
      completed: DEFAULT_TASK_VIEW_OPTIONS,
    })
    storage.set('dsh-enterprise-task-view-options', JSON.stringify({
      pending: { groupBy: 'bogus', orderBy: 'sideways' },
      completed: { groupBy: 'processType' },
    }))
    expect(loadTaskViewState()).toEqual({
      pending: DEFAULT_TASK_VIEW_OPTIONS,
      completed: { groupBy: 'processType', orderBy: DEFAULT_TASK_VIEW_OPTIONS.orderBy },
    })
  })
})
