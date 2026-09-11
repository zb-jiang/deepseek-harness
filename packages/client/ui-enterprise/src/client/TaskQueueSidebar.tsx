/**
 * 待办队列:原生 sidebar 的 enterprise nav 座位占据者。
 *
 * <p>注册进 ui-sidebar 声明的 `sidebar.nav` 槽 —— SidebarRoot 的
 * enterpriseLayout 分支在 navArea 渲染它,原生 workspaces 会话浏览、
 * New Session 与 Settings 保留在各自座位(企业 profile 与上游 DSH 的
 * 合并面最大化保留原生能力)。宽态渲染待办/已完成两组列表,任务驱动
 * 导航:待办点击经 workbench.openTask 绑定专属会话;已完成来自引擎
 * 历史数据(持久,刷新仍在),点击回看本地会话或只读档案。窄轨(wide=
 * false,56px)渲染计数徽标,点击展开。未登录时由 shell.overlay 认证
 * 遮罩盖住整帧,这里只渲染占位。
 */
import { useEffect } from 'react'
import clsx from 'clsx'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { EnterpriseWorkbench } from './enterprise-workbench.ts'
import { useAuth } from './EnterpriseUi.tsx'
import { formatShortTime, useSnapshot } from './workbench/hooks.ts'
import css from './TaskQueueSidebar.module.css'

/** nav 座位注入面:工作台编排器。 */
export type TaskQueueSidebarInjected = {
  workbench: EnterpriseWorkbench
}

/** nav 座位组件 props:owner(wide)+ 注入面 + 全局标准 kit(useSessions)。 */
export type TaskQueueSidebarProps =
  & PropsRuntime<'sidebar.nav'>
  & TaskQueueSidebarInjected

/** 待办队列 nav 座位(见模块文档)。 */
export function TaskQueueSidebar({ wide, workbench, useSessions }: TaskQueueSidebarProps) {
  const { currentUser, loading: authLoading, switchAccount } = useAuth()
  const tasks = useSnapshot(workbench.tasks)
  const bindings = useSnapshot(workbench.bindings)
  const currentSession = useSessions(s => s.current)
  const authed = !authLoading && currentUser !== null && currentUser.status === 'active'

  useEffect(() => {
    if (authed) void workbench.refresh()
  }, [authed, workbench])

  if (!wide) {
    return (
      <button
        type="button"
        className={css.rail}
        onClick={() => { workbench.expandSidebar() }}
        title={`待办 ${tasks.items.length} 项,点击展开`}
      >
        <span className={css.railIcon} aria-hidden>
          <svg viewBox="0 0 16 16" width="18" height="18">
            <path
              d="M2.5 3h11a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-4l-2.5 2.5V10.5h-4.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"
              fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className={css.railCount}>{tasks.items.length}</span>
      </button>
    )
  }

  return (
    <div className={css.sidebar}>
      <div className={css.header}>
        <span className={css.headerTitle}>任务工作台</span>
        {authed && (
          <button
            type="button"
            className={css.refresh}
            onClick={() => { void workbench.refresh() }}
            disabled={tasks.loading}
            title="刷新待办与已完成列表"
          >
            {tasks.loading ? '刷新中…' : '刷新'}
          </button>
        )}
      </div>

      <div className={css.listArea}>
        <div className={css.sectionTitle}>
          我的待办
          <span className={css.countBadge}>{tasks.items.length}</span>
        </div>

        <div className={css.list}>
          {authed && tasks.loading && tasks.items.length === 0 && <div className={css.hint}>加载中…</div>}
          {authed && !tasks.loading && tasks.error !== null && (
            <div className={css.error}>{tasks.error}</div>
          )}
          {authed && !tasks.loading && tasks.error === null && tasks.items.length === 0 && (
            <div className={css.hint}>暂无待办任务</div>
          )}
          {tasks.prefillNotice !== null && tasks.items.length > 0 && (
            <div className={css.notice} title={tasks.prefillNotice}>{tasks.prefillNotice}</div>
          )}
          {tasks.skillPreparing && (
            <div className={css.notice}>正在准备任务技能…</div>
          )}
          {tasks.skillNotice !== null && (
            <div className={css.notice} title={tasks.skillNotice}>{tasks.skillNotice}</div>
          )}
          {tasks.items.map((task) => {
            const bound = bindings.taskToSession[task.id]
            const active = bound !== undefined && bound === currentSession
            return (
              <button
                key={task.id}
                type="button"
                className={clsx(css.taskItem, active && css.taskItemActive)}
                onClick={() => { void workbench.openTask(task) }}
                disabled={tasks.skillPreparing}
              >
                <div className={css.taskName}>{task.name ?? task.id}</div>
                <div className={css.taskProcess}>{task.processDefinitionName ?? task.processDefinitionId}</div>
                <div className={css.taskMeta}>
                  <span>{task.startUserName ?? task.startUserId ?? '未知发起人'}</span>
                  <span>{formatShortTime(task.createTime)}</span>
                  {active && <span className={css.sessionTag}>处理中</span>}
                </div>
              </button>
            )
          })}
        </div>

        {authed && (
          <>
            <div className={clsx(css.sectionTitle, css.sectionTitleSecondary)}>
              已完成
              <span className={css.countBadge}>{tasks.completed.length}</span>
            </div>
            <div className={css.list}>
              {tasks.completed.length === 0 && <div className={css.hint}>暂无已完成任务</div>}
              {tasks.completed.map((task) => {
                const session = bindings.completedByTask[task.id]
                const active = session !== undefined && session === currentSession
                return (
                  <button
                    key={task.id}
                    type="button"
                    className={clsx(css.taskItem, css.doneItem, active && css.taskItemActive)}
                    onClick={() => { workbench.openCompletedTask(task) }}
                  >
                    <div className={css.taskName}>{task.name ?? task.id}</div>
                    <div className={css.taskMeta}>
                      <span className={css.doneTag}>已提交</span>
                      <span>{task.endTime !== null ? formatShortTime(task.endTime) : ''}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </>
        )}
      </div>

      {authed && (
        <div className={css.footer}>
          <span className={css.footerUser} title={currentUser?.email ?? ''}>
            {currentUser?.displayName ?? ''}
          </span>
          <button type="button" className={css.logout} onClick={() => { void switchAccount() }}>
            退出
          </button>
        </div>
      )}
    </div>
  )
}
