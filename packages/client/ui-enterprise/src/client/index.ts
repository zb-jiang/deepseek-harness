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
 *
 * <p>知识库三面(design 2026-09-11 §6):KnowledgeWorkbench 同样在 apply
 * 构造一次;选择器入口占据 `conversation.input.left`(仅待办会话且应用
 * 已开通时渲染),已选文档 chip 行占据 `conversation.input.dock`,输入框
 * '@' 知识库文档触发源注册进 ctx.inputTriggers(待办会话候选 → 内联
 * chip),工作空间文件行的「上传到知识库」占据 ui-sidebar-files 声明的
 * `sidebar.files.entry.action`(readAll 经 ctx.remote.workspaceFiles 绑定);
 * 历史消息里的 `知识库文档 docid: <id>` wire 文本经 ui-primitives 的
 * registerUserTextDecorator 注册装饰器恢复为文档徽标。座位由其他包的注册
 * 声明,经 ctx.slots.inject 延迟到声明后注册。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { registerUserTextDecorator } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { EnterpriseOverlay } from './EnterpriseUi.tsx'
import { ARCHIVE_TAB_ID, ARCHIVE_TAB_KIND, EnterpriseWorkbench } from './enterprise-workbench.ts'
import { KnowledgeWorkbench } from './knowledge-workbench.ts'
import { buildKbDocsSource } from './kb-trigger-source.ts'
import { buildKbDocDecorator } from './kb-doc-decorator.tsx'
import { TaskArchivePanel } from './TaskArchivePanel.tsx'
import { TaskQueueSidebar } from './TaskQueueSidebar.tsx'
import { KbChipsDock } from './KbChipsDock.tsx'
import { KbPickerButton } from './KbPickerButton.tsx'
import { KbUploadAction } from './KbUploadAction.tsx'
import type { KbUploadInjected } from './KbUploadAction.tsx'

export const inject = [
  'slots', 'sessions', 'workspaces', 'uiWorkspace', 'layout', 'conversation', 'inputTriggers', 'sidebarRight',
  'sidebarRightTabs', 'remote', 'remote.workspaceFiles',
]

export function apply(ctx: ClientContext): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.dshEnterpriseProfile = 'true'
  }

  const workbench = new EnterpriseWorkbench({
    sessions: ctx.sessions,
    workspaces: ctx.workspaces,
    uiWorkspace: ctx.uiWorkspace,
    layout: ctx.layout,
    conversation: ctx.conversation,
    sidebarRight: ctx.sidebarRight,
  })

  const knowledge = new KnowledgeWorkbench({
    sessions: ctx.sessions,
    conversation: ctx.conversation,
  })

  // 输入框 '@' 知识库文档触发源:待办会话候选 → 内联 chip(退订器由 effect 持有)。
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => inputTriggers.registerSource(buildKbDocsSource({ workbench, knowledge })), 'ui-enterprise: @kbDocs source')

  // 历史消息的知识库文档徽标:wire 文本 `知识库文档 docid: <id>` → 文档 chip。
  ctx.effect(() => registerUserTextDecorator(buildKbDocDecorator()), 'ui-enterprise: kb doc history decorator')

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

  // 知识库选择器入口:输入框左侧(仅待办会话且应用已开通时渲染)。
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'kb-picker',
    inject: () => ({ workbench, knowledge }),
  }, KbPickerButton))

  // 知识库文档 chip 行:输入框上方 dock(已选文档展示与移除)。
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'kb-chips',
    order: 5,
    inject: () => ({ knowledge }),
  }, KbChipsDock))

  // 工作空间文件行「上传到知识库」:readAll 读全文 → 代理 multipart 上传。
  const readWorkspaceFile: KbUploadInjected['readWorkspaceFile'] =
    (sessionId, path, signal) => ctx.remote.workspaceFiles.readAll(sessionId, path, signal)
  ctx.slots.inject('sidebar.files.entry.action', () => ctx.slots.register({
    name: 'sidebar.files.entry.action',
    id: 'kb-upload',
    inject: () => ({ readWorkspaceFile }),
  }, KbUploadAction))
}
