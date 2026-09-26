/**
 * 企业流程工作台控制器:待办/已完成列表 store、任务↔会话绑定、打开/提交编排。
 *
 * <p>待办队列侧栏(原生 sidebar 的 nav 座位)与档案栏都从这里读数据:任务列表经
 * /dsh/tasks 代理拉取,已完成列表经 /dsh/history/tasks 持久查询(刷新后仍在);
 * 每个待办首次点击时经 SessionsCreatePort 新建专属 DSH 会话并绑定,再次点击回到
 * 原会话。userPrompt 预填走 conversation.input 的草稿写路径,仅在草稿为空时填入,
 * 不覆盖员工已编辑的内容;预填失败原因记入 prefillNotice(侧栏提示,便于诊断);
 * 提交完成后解绑、记录回执并刷新队列。打开待办前先经 skill-sync 的即时安装
 * 端点确保 dshMeta.skillRefs 就绪(仍缺失走 skillNotice 降级提示,不阻断会话;
 * skill-repo-design §7)。
 *
 * <p>任务会话仍处草稿期(未发送过消息、输入框已清空)时,员工在对话区顶部切换
 * 目录后重新点击待办,绑定会迁移到新工作区的当前空白会话(原生目录切换已把草稿
 * 与图片移交过去,认领即跟随);已有对话历史的任务会话不迁移,点击待办回到原会话
 * (历史留在原地可达)。
 *
 * <p>首次点击未绑定待办不再自动挑选工作区:进入"选择工作空间"弹窗,由员工显式
 * 选定并确认(弹窗明示选定后不可修改)后才新建专属会话并绑定;取消或未确认时不
 * 产生任何会话,可反复重新选择。绑定(含草稿期迁移后的重绑)写入 localStorage,
 * 刷新后回到原会话,不再产生孤儿会话。
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
import type { IWorkspaces, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ISidebarRight } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { completeTask, ensureSkills, getCompletedTasks, getMyTasks } from './task-api.ts'
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
  /**
   * 等待员工在"选择工作空间"弹窗中确认的待办(首次点击未绑定待办时置入;
   * 确认/取消后清空)。null = 无待确认任务。
   */
  pendingTask: Task | null
  /** 正在确保待办 skill 就绪(打开待办前的即时安装窗口;侧栏提示+防连点)。 */
  skillPreparing: boolean
  /** 最近一次 skill 就绪失败的降级提示;null = 无失败或未触发(侧栏提示)。 */
  skillNotice: string | null
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

/** localStorage 键:进行中任务的会话绑定(刷新后回到原会话)。 */
const TASK_SESSIONS_KEY = 'dsh-enterprise-task-sessions'

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

/** 读取持久化的进行中任务→会话绑定;无存储或条目损坏按空处理。 */
function loadTaskSessions(): Record<string, SessionId> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(TASK_SESSIONS_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as Record<string, SessionId>
  } catch {
    // localStorage 条目损坏(JSON 解析失败):按无绑定处理,待办重新走
    // 工作空间选择弹窗,不阻断工作台。
    return {}
  }
}

/** 写回持久化的进行中任务绑定;存储不可写(私隐模式/配额)时仅内存生效。 */
function saveTaskSessions(map: Record<string, SessionId>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(TASK_SESSIONS_KEY, JSON.stringify(map))
  } catch {
    // 写失败只损失刷新后的绑定恢复,内存绑定当次会话仍有效。
  }
}

/** 控制器依赖的六个跨插件服务面。 */
export interface WorkbenchDeps {
  readonly sessions: ISessions
  readonly workspaces: IWorkspaces
  /** 会话导航面(官方 ui-workspace):openSession/startSession 是官方重构后主区切换的唯一入口。 */
  readonly uiWorkspace: UiWorkspace
  readonly layout: ILayout
  readonly conversation: IConversation
  readonly sidebarRight: ISidebarRight
}

/** 任务档案标签页的类型标识(rightbar 标签页系统 openTab 的 kind)。 */
export const ARCHIVE_TAB_KIND = 'dsh-enterprise-archive'

/** 任务档案标签页实现的注册 id(stage-two keyed 座位的 key)。 */
export const ARCHIVE_TAB_ID = '@deepseek-ai/dsh-client-ui-enterprise/archive'

/** "浏览本地文件夹"选目录的结果(WorkspacePickerDialog 据此更新选中/提示)。 */
export type WorkspacePickResult =
  | { status: 'picked'; workspaceId: WorkspaceId }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }

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
      prefillNotice: null, selectedCompleted: null, pendingTask: null,
      skillPreparing: false, skillNotice: null,
    })
    // 刷新恢复:持久化的进行中绑定先入 store(反向索引同步重建),绑定会话
    // 已被删除时 openTask 的存续检查会退回工作空间选择弹窗。
    const persistedTasks = loadTaskSessions()
    const persistedReverse: Record<string, string> = {}
    for (const [taskId, sessionId] of Object.entries(persistedTasks)) {
      persistedReverse[sessionId] = taskId
    }
    this.bindings = createSnapshotStore<WorkbenchBindingsState>({
      taskToSession: persistedTasks, sessionToTask: persistedReverse,
      completedBySession: {}, completedByTask: {},
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
   * 打开一个待办:先确保 skillRefs 就绪(即时安装,降级不阻断;见
   * ensureSkillsReady),然后回到已绑定会话;未绑定时进入"选择工作空间"
   * 弹窗(pendingTask 置位,由 TaskQueueSidebar 渲染),员工显式选定并
   * 确认后才经 confirmPendingTaskWorkspace 新建专属会话并预填任务指令。
   * 建会话走 createTaskSession(每任务一个干净会话;connectWorkspace
   * 会复用工作区的空白会话,其残留草稿会拦截预填且多任务会错绑到同一会话)。
   * 预填失败原因记入 prefillNotice 供侧栏提示。
   * @param task - 队列中选中的待办。
   */
  async openTask(task: Task): Promise<void> {
    this.tasks.update((draft) => { draft.selectedCompleted = null })
    // 工作项 3:先确保 skillRefs 就绪再进入会话(已就绪时是纯本地目录检查,无出站)
    await this.ensureSkillsReady(task)
    const bound = this.bindings.getSnapshot().taskToSession[task.id]
    const sessionLive = bound !== undefined
      && this.deps.sessions.list.getSnapshot().byId[bound] !== undefined
    if (sessionLive && bound !== undefined) {
      const sessionId = bound
      const prefillNotice = this.prefillPrompt(task, sessionId)
      this.tasks.update((draft) => { draft.prefillNotice = prefillNotice })
      this.deps.uiWorkspace.openSession(sessionId)
      this.openArchiveTab(sessionId)
      return
    }
    // 未绑定(首次点击,或持久绑定对应的会话已不存在):交给员工显式
    // 选择工作空间,不自动挑选、不预建会话;取消前不产生任何绑定。
    this.tasks.update((draft) => { draft.pendingTask = task })
  }

  /**
   * 员工在"选择工作空间"弹窗中确认后调用:在选定工作区新建专属会话、
   * 建立绑定(含 localStorage 持久化)、预填任务指令并进入会话与档案栏。
   * 建会话失败时保留弹窗(pendingTask 不清空),员工可重试或取消。
   * @param workspaceId - 员工在弹窗中选定的工作区。
   */
  async confirmPendingTaskWorkspace(workspaceId: WorkspaceId): Promise<void> {
    const task = this.tasks.getSnapshot().pendingTask
    if (task === null) return
    const sessionId = await this.createTaskSession(workspaceId)
    if (sessionId === undefined) return
    this.bind(task.id, sessionId)
    const prefillNotice = this.prefillPrompt(task, sessionId)
    this.tasks.update((draft) => {
      draft.pendingTask = null
      draft.prefillNotice = prefillNotice
    })
    this.deps.uiWorkspace.openSession(sessionId)
    this.openArchiveTab(sessionId)
  }

  /** 员工取消"选择工作空间"弹窗:清空待确认任务,不产生会话与绑定。 */
  cancelPendingTask(): void {
    if (this.tasks.getSnapshot().pendingTask === null) return
    this.tasks.update((draft) => { draft.pendingTask = null })
  }

  /**
   * 弹窗内"浏览本地文件夹"入口:打开宿主目录选择器(桌面版是 OS 原生
   * 文件夹对话框,Web 端由 in-app browse 后端承接),选定后把该路径注册为
   * 新工作区(Host 幂等:路径已注册时返回既有工作区)并返回其 id,弹窗随之
   * 选中新工作区,员工仍需显式确认才建会话绑定。
   * @returns picked 携带新建(或既有)工作区 id;cancelled 为员工取消选择;
   *          error 携带可供弹窗展示的失败原因。
   */
  async pickNewWorkspace(): Promise<WorkspacePickResult> {
    let path: string | null
    try {
      path = await this.deps.uiWorkspace.pickDirectory()
    } catch (error: unknown) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
    }
    if (path === null) return { status: 'cancelled' }
    try {
      const workspace = await this.deps.workspaces.create({ path })
      return { status: 'picked', workspaceId: workspace.workspaceId }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      return { status: 'error', message: `注册工作区失败:${detail}` }
    }
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
      this.deps.uiWorkspace.openSession(sessionId)
      this.openArchiveTab(sessionId)
    } else {
      this.tasks.update((draft) => { draft.selectedCompleted = task })
      // 只读档案路径不切换会话:档案标签落到当前已挂载会话的表面即可。
      this.openArchiveTab(undefined)
    }
  }

  /**
   * 打开任务档案标签页,并保证它落在目标会话的 rightbar 表面上。
   *
   * <p>openSession 与 rightbar 座位的挂载/绑定不在同一帧:点击后同步调
   * openTab,经 require() 拿到的是"上一个已挂载会话"的绑定,标签会落错
   * 表面——新会话的座位随后以空表面挂载且默认收起,表现为档案栏不再弹出、
   * 刷新后才恢复几次(官方 mounted 可观测面正是为此暴露:等座位发布目标
   * 会话后再开)。目标会话 3 秒内仍未挂载(主区被切走/无会话)时放弃并
   * 退订,避免悬挂订阅。
   * @param target - 要显示档案栏的会话;undefined 表示落到当前已挂载会话
   *   (只读档案路径:不切换会话,当前会话即可)。
   */
  private openArchiveTab(target: SessionId | undefined): void {
    const mounted = this.deps.sidebarRight.mounted
    const open = (): void => { this.deps.sidebarRight.openTab(ARCHIVE_TAB_KIND) }
    const current = mounted.getSnapshot()
    if (current === target || (target === undefined && current !== undefined)) {
      open()
      return
    }
    const timer = setTimeout(() => { unsubscribe() }, 3000)
    const unsubscribe = mounted.subscribe(() => {
      const now = mounted.getSnapshot()
      if (now === undefined || (target !== undefined && now !== target)) return
      unsubscribe()
      clearTimeout(timer)
      open()
    })
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
   * 确保待办的 skillRefs 就绪(skill-repo-design §7):已就绪时纯本地目录
   * 检查,缺失时触发即时同步安装。检查/安装期间置 skillPreparing(侧栏
   * 提示+防连点);仍缺失或请求失败只记 skillNotice 走降级提示,不阻断
   * 会话创建(AI 会话照常进行,仅 skill 工具调不到该技能)。
   * @param task - 即将打开的待办。
   */
  private async ensureSkillsReady(task: Task): Promise<void> {
    const names = task.dshMeta?.skillRefs ?? []
    const unique = [...new Set(names.filter(name => name !== ''))]
    if (unique.length === 0) {
      // 无 skillRefs 的任务不受上一次降级提示影响(清残留)
      if (this.tasks.getSnapshot().skillNotice !== null) {
        this.tasks.update((draft) => { draft.skillNotice = null })
      }
      return
    }
    this.tasks.update((draft) => { draft.skillPreparing = true })
    try {
      const missing = await ensureSkills(unique)
      if (missing.length > 0) {
        this.tasks.update((draft) => {
          draft.skillNotice = `技能 ${missing.join('、')} 未能安装;会话将继续,但 AI 无法调用该技能`
        })
      } else {
        this.tasks.update((draft) => { draft.skillNotice = null })
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.tasks.update((draft) => {
        draft.skillNotice = `技能就绪检查失败(${message});会话将继续,但 AI 可能无法调用任务技能`
      })
    } finally {
      this.tasks.update((draft) => { draft.skillPreparing = false })
    }
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

  /** 建立任务↔会话双向绑定(重绑时覆盖旧正向记录),并持久化正向映射。 */
  private bind(taskId: string, sessionId: SessionId): void {
    this.bindings.update((draft) => {
      draft.taskToSession[taskId] = sessionId
      draft.sessionToTask[sessionId] = taskId
    })
    saveTaskSessions(this.bindings.getSnapshot().taskToSession)
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
    // 提交完成后任务不再"进行中":从持久化绑定中移除,避免刷新后残留。
    saveTaskSessions(this.bindings.getSnapshot().taskToSession)
  }
}
