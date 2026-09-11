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
 * <p>任务会话仍处草稿期(未发送过消息、输入框已清空)时,员工在对话区顶部切换
 * 目录后重新点击待办,绑定会迁移到新工作区的当前空白会话(原生目录切换已把草稿
 * 与图片移交过去,认领即跟随);已有对话历史的任务会话不迁移,点击待办回到原会话
 * (历史留在原地可达)。
 *
 * <p>绑定状态刻意用普通对象而非 Map/Set:快照存储引擎经 immer produce 起草,
 * 而运行时导入的 immer 未启用 MapSet 插件,Map 草稿在首次变更时抛
 * "[Immer] minified error nr: 0"。已完成任务的会话映射另存 localStorage,
 * 页面刷新后仍能回到原会话;任务档案经 rightbar 标签页系统呈现
 * (openTask/openCompletedTask 打开 ARCHIVE_TAB_KIND 标签页)。
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
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

/** 控制器依赖的五个跨插件服务面。 */
export interface WorkbenchDeps {
  readonly sessions: ISessions
  readonly workspaces: IWorkspaces
  readonly layout: ILayout
  readonly conversation: IConversation
  readonly sidebarRight: ISidebarRight
}

/** 任务档案标签页的类型标识(rightbar 标签页系统 openTab 的 kind)。 */
export const ARCHIVE_TAB_KIND = 'dsh-enterprise-archive'

/** 任务档案标签页实现的注册 id(stage-two keyed 座位的 key)。 */
export const ARCHIVE_TAB_ID = '@deepseek-ai/dsh-client-ui-enterprise/archive'

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
   *
   * <p>绑定会话仍存续时先尝试 adoptCurrentBlank:员工切换到其他工作区的
   * 空白会话(原生目录选择已移交草稿/图片)后重新点击待办,任务绑定迁移过去,
   * 工作区不再退回原会话所在地;不满足迁移守卫时维持回到原会话。
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
      const sessions = this.deps.sessions.list.getSnapshot()
      // 与原生 startSession 同判据:当前会话所在工作区 → 最近活跃工作区 → 首个。
      const currentSessionId = sessions.current
      const currentWorkspaceId = currentSessionId === undefined
        ? undefined
        : workspaces.items.find(item => item.sessionIds.includes(currentSessionId))?.workspaceId
      const workspaceId = currentWorkspaceId
        ?? this.recentWorkspaceId(workspaces.items, sessions.byId)
        ?? workspaces.items[0]?.workspaceId
      if (workspaceId === undefined) {
        this.deps.sessions.clear()
        return
      }
      sessionId = await this.createTaskSession(workspaceId)
      if (sessionId === undefined) return
      this.bind(task.id, sessionId)
    } else {
      const adopted = this.adoptCurrentBlank(task.id, sessionId)
      if (adopted !== undefined) sessionId = adopted
    }
    const prefillNotice = this.prefillPrompt(task, sessionId)
    this.tasks.update((draft) => { draft.prefillNotice = prefillNotice })
    this.deps.sessions.open(sessionId)
    this.deps.sidebarRight.openTab(ARCHIVE_TAB_KIND)
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
    this.deps.sidebarRight.openTab(ARCHIVE_TAB_KIND)
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

  /**
   * 最近活跃工作区(与原生 navigation.recentWorkspace 同判据):取各工作区
   * 内会话的最新 updatedAt,无会话时退化为创建时间,并列时保持 Host 顺序。
   */
  private recentWorkspaceId(
    workspaces: readonly WorkspaceView[],
    sessions: Record<string, { updatedAt: number }>,
  ): WorkspaceId | undefined {
    let selected: WorkspaceId | undefined
    let selectedTime = Number.NEGATIVE_INFINITY
    for (const workspace of workspaces) {
      let latest = Number.NEGATIVE_INFINITY
      for (const sessionId of workspace.sessionIds) {
        const session = sessions[sessionId]
        if (session !== undefined) latest = Math.max(latest, session.updatedAt)
      }
      if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
      if (selected === undefined || latest > selectedTime) {
        selected = workspace.workspaceId
        selectedTime = latest
      }
    }
    return selected
  }

  /** 建立任务↔会话双向绑定(重绑时覆盖旧正向记录)。 */
  private bind(taskId: string, sessionId: SessionId): void {
    this.bindings.update((draft) => {
      draft.taskToSession[taskId] = sessionId
      draft.sessionToTask[sessionId] = taskId
    })
  }

  /**
   * 把仍处草稿期的任务迁移到当前空白会话(员工切换工作区后重新点击待办)。
   *
   * <p>原生对话区顶部的目录选择会把当前会话的草稿与图片移交给新工作区的
   * 空白会话再导航过去;绑定仍指向旧工作区的原会话时,点击待办会跳回旧工作区,
   * 员工无法在自选目录下处理待办。这里在守卫全过时把绑定认领到当前空白会话,
   * 移交过来的草稿/图片原地可用。
   *
   * <p>守卫(任一不满足即返回 undefined,维持回到原会话的现状):
   * <ol>
   *   <li>当前会话存在、≠ 绑定会话、是空白会话、且未绑定其他任务
   *       (认领会话不能劫持已有对话或他人任务);</li>
   *   <li>绑定会话仍是空白(未发送过消息)且输入框无草稿/图片
   *       (有内容滞留说明内容还在原会话,迁移会丢;已有对话历史的
   *       任务会话同样不迁移——历史留在原地仍可达);</li>
   *   <li>两会话分属不同工作区,且当前会话的工作区可解析
   *       (绑定会话的工作区已被删除时视为不同,允许迁移)。</li>
   * </ol>
   *
   * @param taskId - 目标待办 id。
   * @param boundId - 当前绑定的会话。
   * @returns 迁移后的会话 id;未迁移为 undefined。
   */
  private adoptCurrentBlank(taskId: string, boundId: SessionId): SessionId | undefined {
    const sessions = this.deps.sessions.list.getSnapshot()
    const current = sessions.current
    if (current === undefined || current === boundId) return undefined
    const currentRow = sessions.byId[current]
    const boundRow = sessions.byId[boundId]
    if (currentRow === undefined || boundRow === undefined) return undefined
    if (!currentRow.blank || !boundRow.blank) return undefined
    if (this.bindings.getSnapshot().sessionToTask[current] !== undefined) return undefined
    const boundState = this.sessionInput(boundId)?.state.getSnapshot()
    if (boundState === undefined || boundState.draft !== '' || boundState.attachmentIds.length > 0) {
      return undefined
    }
    const workspaces = this.deps.workspaces.list.getSnapshot()
    const workspaceOf = (id: SessionId): WorkspaceId | undefined =>
      workspaces.items.find(item => item.sessionIds.includes(id))?.workspaceId
    const currentWorkspace = workspaceOf(current)
    if (currentWorkspace === undefined || currentWorkspace === workspaceOf(boundId)) {
      return undefined
    }
    this.rebind(taskId, current)
    // 迁移后的指令补填只面向空草稿:已携带的草稿本就是移交过来的任务指令
    // (或员工自己的内容),标记已填避免 prefillPrompt 误报"输入框已有内容"。
    const draft = this.sessionInput(current)?.state.getSnapshot().draft ?? ''
    if (draft === '') this.prefilledTasks.delete(taskId)
    else this.prefilledTasks.add(taskId)
    return current
  }

  /** 迁移任务绑定到新会话,并清掉旧会话上的反向索引(旧会话退化为普通会话)。 */
  private rebind(taskId: string, sessionId: SessionId): void {
    this.bindings.update((draft) => {
      const previous = draft.taskToSession[taskId]
      if (previous !== undefined && previous !== sessionId) {
        // spread+rest 移除键,绕开 lint 的 no-dynamic-delete(与 unbind 同理)
        const { [previous]: _stale, ...rest } = draft.sessionToTask
        draft.sessionToTask = rest
      }
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
