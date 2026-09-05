/**
 * 企业工作台客户端入口:三栏骨架的装配点。
 *
 * <p>待办队列注册进原生 sidebar 的 `sidebar.nav` 座位(SidebarRoot 的
 * enterpriseLayout 分支渲染),原生 workspaces 会话浏览/New Session/Settings
 * 全部保留(企业 profile 与上游 DSH 的合并面最大化保留原生能力);档案栏
 * 注册 TaskArchivePanel 遮蔽 ui-conversation 的 DetailsPanel;中间会话区
 * 保持原生 ConversationRoot。EnterpriseWorkbench 在 apply 构造一次,经两个
 * 占据者的 inject 面分发。认证遮罩(shell.overlay)未登录时盖住整帧。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { EnterpriseOverlay } from './EnterpriseUi.tsx'
import { EnterpriseWorkbench } from './enterprise-workbench.ts'
import { TaskArchivePanel } from './TaskArchivePanel.tsx'
import { TaskQueueSidebar } from './TaskQueueSidebar.tsx'

export const inject = ['slots', 'sessions', 'workspaces', 'layout', 'conversation']

export function apply(ctx: ClientContext): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.dshEnterpriseProfile = 'true'
  }

  const workbench = new EnterpriseWorkbench({
    sessions: ctx.sessions,
    workspaces: ctx.workspaces,
    layout: ctx.layout,
    conversation: ctx.conversation,
  })

  // 认证遮罩:未登录/待审批/被禁用时盖住整帧。
  ctx.slots.register(
    { name: 'shell.overlay', id: 'enterprise', order: 50 },
    EnterpriseOverlay,
  )

  // 待办队列:原生 sidebar 的 enterprise nav 座位。
  ctx.slots.register({
    name: 'sidebar.nav',
    inject: () => ({ workbench }),
  }, TaskQueueSidebar)

  // 任务档案栏,遮蔽 ui-conversation 的 DetailsPanel。
  ctx.slots.register({
    name: 'details',
    priority: -10,
    inject: () => ({
      workbench,
      closeDetails: () => { ctx.layout.closeDetails() },
    }),
  }, TaskArchivePanel)
}
