/**
 * 企业流程工作台控制器:待办/已完成列表 store、任务↔会话绑定、打开/提交编排。
 *
 * <p>待办队列侧栏(原生 sidebar 的 nav 座位)与档案栏都从这里读数据:任务列表经
 * /dsh/tasks 代理拉取,已完成列表经 /dsh/history/tasks 持久查询(刷新后仍在);
 * 每个待办首次点击时经 SessionsCreatePort 新建专属 DSH 会话并绑定,再次点击回到
 * 原会话。userPrompt 预填走 conversation.input 的草稿写路径,仅在草稿为空时填入,
 * 不覆盖员工已编辑的内容;预填失败原因记入 prefillNotice(侧栏提示,便于诊断);
 * 提交完成后解绑、记录回执并刷新队列。
 *
 * <p>绑定状态刻意用普通对象而非 Map/Set:快照存储引擎经 immer produce 起草,
 * 而运行时导入的 immer 未启用 MapSet 插件,Map 草稿在首次变更时抛
 * "[Immer] minified error nr: 0"。已完成任务的会话映射另存 localStorage,
 * 页面刷新后仍能回到原会话;details 栏的 pin(ui-layout 的 opt-in 能力)由
 * 侧栏渲染面经 syncPin 驱动,使 blank 任务会话也能展开右栏。
 */
import type {
  ISessions, IWorkspaces, SessionId, SnapshotStore, WorkspaceId,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { completeTask, getCompletedTasks, getMyTasks } from './task-api.ts'
import type { CompletedTask, Task } from './task-api.ts'

/**
 * 跨域会话端口的最小创建面:运行时的 SessionRuntime 同时满足 ISessions
 * (UI 公开面,刻意不暴露 create——"New Session"走 workspaces 的空白会话
 * 复用)与 SessionsPort(跨域面,含 create),装配与测试注入处已做结构
 * 校验。任务绑定需要"新建不复用"的会话(connectWorkspace 的复用会把上
 * 一个任务的残留草稿和绑定错交给下一个任务),因此经此结构化断言取实
 * 现上的 create。断言完全留在企业包内,上游契约零改动。
 */
type SessionsCreatePort = {
  create(opts: { workspaceId: WorkspaceId }): Promise<SessionId>
}

/** 待办队列状态(侧栏与档案栏共享)。 */
export type WorkbenchTasksState = {
  items: readonly Task[]
  /** 已完成历史任务(引擎持久数据,侧栏"已完成"分组)。 */
  completed: readonly CompletedTask[]
  loading: boolean
  error: string | null
  /** 最近一次预填失败的诊断提示;null = 成功或未触发(侧栏细提示)。 */
  prefillNotice: string | null
  /** 档案栏正在只读查看的已完成任务(无本地会话时的回看入口)。 */
  selectedCompleted: CompletedTask | null
}

/** 已提交完成任务的档案记录(解绑后档案栏的"已完成"回执)。 */
export type CompletedTaskRecord = {
  /** 引擎任务 id(与历史任务 id 一致;据此在已完成列表定位完整档案数据)。 */
  taskId: string
  taskName: string
  submittedAt: number
}

/** 任务↔会话绑定状态(普通对象 + immer 核心 draft 路径;见模块文档)。 */
export type WorkbenchBindingsState = {
  /** taskId → 绑定会话 id。 */
  taskToSession: Record<string, SessionId>
  /** sessionId → 绑定任务 id(反向索引)。 */
  sessionToTask: Record<string, string>
  /** sessionId → 已提交完成任务记录。 */
  completedBySession: Record<string, CompletedTaskRecord>
  /** taskId → 提交时所在会话(已完成任务回看本地会话的入口)。 */
  completedByTask: Record<string, SessionId>
}

/** localStorage 键:已完成任务的会话映射(刷新后回看聊天历史的入口)。 */
const COMPLETED_SESSIONS_KEY = 'dsh-enterprise-completed-sessions'

/** 读取持久化的已完成任务→会话映射;无存储或条目损坏按空处理。 */
function loadCompletedSessions(): Record<string, SessionId> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(COMPLETED_SESSIONS_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as Record<string, SessionId>
  } catch {
    // localStorage 条目损坏(JSON 解析失败):按无映射处理,已完成任务
    // 退化为只读档案视图,不阻断工作台。
    return {}
  }
}

/** 写回持久化映射;存储不可写(私隐模式/配额)时仅内存生效。 */
function saveCompletedSessions(map: Record<string, SessionId>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(COMPLETED_SESSIONS_KEY, JSON.stringify(map))
  } catch {
    // 写失败只损失刷新后的回看入口,内存映射当次会话仍有效。
  }
}

/** 控制器依赖的四个跨插件服务面。 */
export interface WorkbenchDeps {
  readonly sessions: ISessions
  readonly workspaces: IWorkspaces
  readonly layout: ILayout
  readonly conversation: IConversation
}

/**
 * 工作台编排器。apply 时构造一次,经各插槽 inject 面闭包分发;
 * 状态面是纯 observable store,组件用 useSyncExternalStore 订阅。
 */
export class EnterpriseWorkbench {
  /** 待办队列(所有列表展示的单一数据源)。 */
  readonly tasks: SnapshotStore<WorkbenchTasksState>
  /** 任务↔会话绑定(高亮与档案归属)。 */
  readonly bindings: SnapshotStore<WorkbenchBindingsState>
  /** 已完成任务→会话的持久映射(刷新后回看聊天历史)。 */
  private readonly completedSessions: Record<string, SessionId>
  /** 已完成预填的任务 id(避免切回任务时重复覆盖草稿)。 */
  private readonly prefilledTasks = new Set<string>()
  private readonly deps: WorkbenchDeps

  /**
   * @param deps - 跨插件服务面(sessions/workspaces/layout/conversation)。
   */
  constructor(deps: WorkbenchDeps) {
    this.deps = deps
    this.tasks = createSnapshotStore<WorkbenchTasksState>({
      items: [], completed: [], loading: false, error: null,
      prefillNotice: null, selectedCompleted: null,
    })
    this.bindings = createSnapshotStore<WorkbenchBindingsState>({
      taskToSession: {}, sessionToTask: {}, completedBySession: {}, completedByTask: {},
    })
    this.completedSessions = loadCompletedSessions()
  }

  /** 拉取当前用户待办与已完成列表(侧栏挂载与手动刷新共用)。 */
  async refresh(): Promise<void> {
    this.tasks.update((draft) => {
      draft.loading = true
      draft.error = null
    })
    try {
      const [items, completed] = await Promise.all([getMyTasks(), getCompletedTasks()])
      this.tasks.update((draft) => {
        draft.items = items
        draft.completed = completed
        draft.loading = false
        draft.error = null
      })
    } catch (e) {
      this.tasks.update((draft) => {
        draft.loading = false
        draft.error = e instanceof Error ? e.message : String(e)
      })
    }
  }

  /**
   * 打开一个待办:回到已绑定会话,或为任务建立专属会话并预填任务指令。
   * 建会话走 createTaskSession(每任务一个干净会话;connectWorkspace 会
   * 复用工作区的空白会话,其残留草稿会拦截预填且多任务会错绑到同一会话)。
   * create 的解析保证会话已入列表且 binding 同步可解析,因此预填可在
   * open 之前写入新会话的输入机(原生 New Session 的 draft hand-off 模式)。
   * 预填失败原因记入 prefillNotice 供侧栏提示。无可用工作区时清空当前
   * 选择(与原生 New Session 行为一致);建连失败记入队列错误面。
   * @param task - 队列中选中的待办。
   */
  async openTask(task: Task): Promise<void> {
    this.tasks.update((draft) => { draft.selectedCompleted = null })
    const bound = this.bindings.getSnapshot().taskToSession[task.id]
    const sessionLive = bound !== undefined
      && this.deps.sessions.list.getSnapshot().byId[bound] !== undefined
    let sessionId: SessionId | undefined = sessionLive === true ? bound : undefined
    if (sessionId === undefined) {
      const workspaces = this.deps.workspaces.list.getSnapshot()
      const workspaceId = workspaces.recentWorkspaceId ?? workspaces.items[0]?.workspaceId
      if (workspaceId === undefined) {
        this.deps.sessions.clear()
        return
      }
      sessionId = await this.createTaskSession(workspaceId)
      if (sessionId === undefined) return
      this.bind(task.id, sessionId)
    }
    const prefillNotice = this.prefillPrompt(task, sessionId)
    this.tasks.update((draft) => { draft.prefillNotice = prefillNotice })
    this.deps.sessions.open(sessionId)
    this.deps.layout.openDetails()
  }

  /**
   * 打开一个已完成任务:提交时的会话(内存映射或 localStorage 持久映射)
   * 还活着则回到该会话并补全完成回执,否则在档案栏只读展示引擎历史
   * (任务信息/完成时间/变量/执行路径)。
   * @param task - 侧栏"已完成"分组中选中的历史任务。
   */
  openCompletedTask(task: CompletedTask): void {
    const memory = this.bindings.getSnapshot().completedByTask[task.id]
    const sessionId = memory ?? this.completedSessions[task.id]
    const sessionLive = sessionId !== undefined
      && this.deps.sessions.list.getSnapshot().byId[sessionId] !== undefined
    if (sessionLive === true && sessionId !== undefined) {
      this.tasks.update((draft) => { draft.selectedCompleted = null })
      // 刷新后内存回执丢失时从历史任务补全,档案栏才能渲染完成回执。
      this.bindings.update((draft) => {
        if (draft.completedBySession[sessionId] === undefined) {
          draft.completedBySession[sessionId] = {
            taskId: task.id,
            taskName: task.name ?? task.id,
            submittedAt: task.endTime !== null ? (Date.parse(task.endTime) || Date.now()) : Date.now(),
          }
        }
        draft.completedByTask[task.id] = sessionId
      })
      this.deps.sessions.open(sessionId)
    } else {
      this.tasks.update((draft) => { draft.selectedCompleted = task })
    }
    this.deps.layout.openDetails()
  }

  /**
   * 把任务指令重新填入会话输入框(档案栏"重新填入"按钮;显式操作,直接覆盖草稿)。
   * @param task - 目标待办。
   * @param sessionId - 绑定会话。
   * @returns 是否成功(无指令或会话不可达为 false)。
   */
  reinsertPrompt(task: Task, sessionId: SessionId): boolean {
    const prompt = task.dshMeta?.userPrompt
    if (prompt == null || prompt === '') return false
    const input = this.sessionInput(sessionId)
    if (input === undefined) return false
    input.setDraft(prompt)
    return true
  }

  /**
   * 提交待办:POST 变量到引擎,解绑会话,记录完成回执并刷新队列;
   * 会话映射同步写入 localStorage 供刷新后回看。
   * @param task - 目标待办。
   * @param variables - 映射后的流程上下文变量。
   * @throws 引擎拒绝时原样抛出(档案栏展示错误)。
   */
  async submitTask(task: Task, variables: Record<string, unknown>): Promise<void> {
    await completeTask(task.id, variables)
    this.unbind(task, 'completed')
    await this.refresh()
  }

  /** 当前会话绑定的待办(档案栏归属判断);无绑定返回 undefined。 */
  taskOfSession(sessionId: SessionId): Task | undefined {
    const taskId = this.bindings.getSnapshot().sessionToTask[sessionId]
    if (taskId === undefined) return undefined
    return this.tasks.getSnapshot().items.find(item => item.id === taskId)
  }

  /**
   * 重算 details 栏 pin 并写入 layout:当前会话是任务会话/持有完成回执,
   * 或处于已完成任务的只读档案视图时置位(blank 任务会话也能展开右栏),
   * 否则交还原生"非 blank 会话"判据。由侧栏渲染面在状态变化时调用
   * (渲染必然晚于 root 挂载,layout 服务面已接线)。
   */
  syncPin(): void {
    const current = this.deps.sessions.list.getSnapshot().current
    const bound = current !== undefined && this.taskOfSession(current) !== undefined
    const receipt = current !== undefined
      && this.bindings.getSnapshot().completedBySession[current] !== undefined
    const readonly = this.tasks.getSnapshot().selectedCompleted !== null
    this.deps.layout.setPinned(bound || receipt || readonly)
  }

  /** 侧栏窄轨展开(layout 面宽切换;与原生侧栏 toggle 同一动作)。 */
  expandSidebar(): void {
    this.deps.layout.toggleSidebar()
  }

  /** 退出已完成任务的只读档案视图(切换会话时由档案栏调用)。 */
  clearSelectedCompleted(): void {
    if (this.tasks.getSnapshot().selectedCompleted === null) return
    this.tasks.update((draft) => { draft.selectedCompleted = null })
  }

  /**
   * 为任务新建(不复用)一个 DSH 会话,失败原因记入队列错误面。
   * 经 SessionsCreatePort 断言取运行时实现上的 create —— 见该类型的
   * 模块文档;断言失败面为零(实现已满足 SessionsPort)。
   * @param workspaceId - 目标工作区。
   * @returns 新会话 id;失败时 undefined(错误已记入 tasks.error)。
   */
  private async createTaskSession(workspaceId: WorkspaceId): Promise<SessionId | undefined> {
    try {
      return await (this.deps.sessions as ISessions & SessionsCreatePort).create({ workspaceId })
    } catch (e) {
      this.tasks.update((draft) => {
        draft.error = e instanceof Error ? e.message : String(e)
      })
      return undefined
    }
  }

  /**
   * 任务指令预填:仅草稿为空且未预填过时写入(不覆盖员工编辑)。
   * @returns 失败原因(人读,记入 prefillNotice);null = 成功或无需预填。
   */
  private prefillPrompt(task: Task, sessionId: SessionId): string | null {
    const prompt = task.dshMeta?.userPrompt
    if (prompt == null || prompt.trim() === '') {
      return '该任务未配置指令(流程定义需重新发布后启动新实例)'
    }
    if (this.prefilledTasks.has(task.id)) return null
    const input = this.sessionInput(sessionId)
    if (input === undefined) return '会话输入面不可用,未能预填指令'
    if (input.state.getSnapshot().draft !== '') {
      return '输入框已有内容,未覆盖;可用档案栏「重新填入」补填'
    }
    input.setDraft(prompt)
    this.prefilledTasks.add(task.id)
    return null
  }

  /** 解析会话的输入面(草稿写路径);会话不在列表/无 scope 时返回 undefined。 */
  private sessionInput(sessionId: SessionId) {
    const actx = this.deps.sessions.scope(sessionId)
    if (actx === undefined) return undefined
    return this.deps.conversation.input.for(actx)
  }

  /** 建立任务↔会话双向绑定(重绑时覆盖旧正向记录)。 */
  private bind(taskId: string, sessionId: SessionId): void {
    this.bindings.update((draft) => {
      draft.taskToSession[taskId] = sessionId
      draft.sessionToTask[sessionId] = taskId
    })
  }

  /** 解除绑定;'completed' 时在会话上留完成回执并把映射持久化。 */
  private unbind(task: Task, reason: 'completed'): void {
    let persisted: SessionId | undefined
    this.bindings.update((draft) => {
      const sessionId = draft.taskToSession[task.id]
      // 用 spread+rest pattern 移除键,绕开 lint 的 no-dynamic-delete 规则
      // (不能改回 Map:immer 运行时未启用 MapSet 插件,Map draft 会崩溃)。
      const { [task.id]: _removed1, ...rest1 } = draft.taskToSession
      draft.taskToSession = rest1
      if (sessionId !== undefined) {
        const { [sessionId]: _removed2, ...rest2 } = draft.sessionToTask
        draft.sessionToTask = rest2
        if (reason === 'completed') {
          draft.completedBySession[sessionId] = {
            taskId: task.id,
            taskName: task.name ?? task.id,
            submittedAt: Date.now(),
          }
          draft.completedByTask[task.id] = sessionId
          persisted = sessionId
        }
      }
    })
    if (persisted !== undefined) {
      this.completedSessions[task.id] = persisted
      saveCompletedSessions(this.completedSessions)
    }
  }
}
