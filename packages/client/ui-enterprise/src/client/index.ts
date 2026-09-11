/**
 * 企业工作台客户端入口:三栏骨架的装配点。
 *
 * <p>待办队列注册进原生 sidebar 的 `sidebar.nav` 座位(SidebarRoot 的
 * enterpriseLayout 分支渲染),原生 workspaces 会话浏览/New Session/Settings
 * 全部保留(企业 profile 与上游 DSH 的合并面最大化保留原生能力);任务档案
 * 注册为 rightbar 标签页系统的 extension 类型(两阶段:类型入
 * ctx.sidebarRightTabs,主体入 `sidebar.right.pane.tab` keyed 座位),
 * openTask/openCompletedTask 经 ctx.sidebarRight.openTab 打开;中间会话区
 * 保持原生 ConversationRoot。EnterpriseWorkbench 在 apply 构造一次,经各
 * 占据者的 inject 面分发。认证遮罩(shell.overlay)未登录时盖住整帧。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { EnterpriseOverlay } from './EnterpriseUi.tsx'
import { ARCHIVE_TAB_ID, ARCHIVE_TAB_KIND, EnterpriseWorkbench } from './enterprise-workbench.ts'
import { TaskArchivePanel } from './TaskArchivePanel.tsx'
import { TaskQueueSidebar } from './TaskQueueSidebar.tsx'

export const inject = [
  'slots', 'sessions', 'workspaces', 'layout', 'conversation', 'sidebarRight', 'sidebarRightTabs',
]

export function apply(ctx: ClientContext): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.dshEnterpriseProfile = 'true'
  }

  const workbench = new EnterpriseWorkbench({
    sessions: ctx.sessions,
    workspaces: ctx.workspaces,
    layout: ctx.layout,
    conversation: ctx.conversation,
    sidebarRight: ctx.sidebarRight,
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

  // 任务档案标签页,stage one:类型声明(extension 带,企业外部实现)。
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ARCHIVE_TAB_ID,
    kind: ARCHIVE_TAB_KIND,
    priority: 'extension',
    title: () => '任务档案',
  }), 'ui-enterprise: archive tab type')

  // 任务档案标签页,stage two:主体注册(keyed 座位,key=类型 id)。
  // 座位声明由 ui-sidebar-right 的 rightbar.session 挂载,inject 保证晚于声明。
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: ARCHIVE_TAB_ID,
    inject: () => ({ workbench }),
  }, TaskArchivePanel))
}
