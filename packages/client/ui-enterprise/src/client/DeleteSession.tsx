/**
 * 已归档会话的「删除会话」操作:三个槽位条目共用一组注入面——
 * `sidebar.workspaces.session.menu.item` 菜单行(order 50,菜单第一项)、
 * `sidebar.workspaces.session.row.action` 悬停按钮、`shell.overlay` 确认
 * 对话框。仅对已归档会话渲染(归档状态经全局 Workspace 快照 selector
 * 读取);确认后请求 Host 端点 /api/enterprise/sessions/delete 物理删除
 * 会话工件并清 Workspace 记账,Host 的 domain/changed 事件经 feed 推回,
 * 已归档列表自动移除该行。
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconTrashOutlineRegular, MenuItemButton, Modal, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable, InjectFace, PropsHooks, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: 拉入 workspace 域的 SlotMap 声明(两个 session 座位 key 的类型)。
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { readToken } from './task-api.ts'
import css from './DeleteSession.module.css'

/** 一次待确认的删除请求:目标会话与其展示标题。 */
export type SessionDeleteRequest = {
  readonly sessionId: SessionId
  readonly displayTitle: string
}

/** 菜单行与悬停按钮共享的注入面:请求 hook 与发起回调。 */
export type SessionDeleteActionInjected = {
  readonly hooks: { readonly deleteRequest: HostObservable<SessionDeleteRequest | null> }
  readonly requestSessionDelete: (sessionId: SessionId, displayTitle: string) => void
}

/** 确认对话框的注入面:请求 hook、结算与执行回调。 */
export type SessionDeleteDialogInjected = {
  readonly hooks: { readonly deleteRequest: HostObservable<SessionDeleteRequest | null> }
  readonly settleSessionDelete: () => void
  readonly deleteSession: (sessionId: SessionId) => Promise<void>
}

/** 菜单行 props:owner 会话标识 + 座位标准面 + 注入面。 */
export type SessionDeleteMenuItemProps =
  & PropsRuntime<'sidebar.workspaces.session.menu.item'>
  & InjectFace<SessionDeleteActionInjected>

/** 悬停按钮 props:owner 会话标识 + 座位标准面 + 注入面。 */
export type SessionDeleteRowActionProps =
  & PropsRuntime<'sidebar.workspaces.session.row.action'>
  & InjectFace<SessionDeleteActionInjected>

/** 确认对话框 props:shell.overlay 标准面 + 注入面(hooks 展开为 selector hook)。 */
export type SessionDeleteDialogProps =
  & PropsRuntime<'shell.overlay'>
  & Omit<SessionDeleteDialogInjected, 'hooks'>
  & PropsHooks<SessionDeleteDialogInjected['hooks']>

/**
 * 请求 Host 物理删除一个已归档会话。
 * @param sessionId - 目标会话。
 * @returns 请求完成(删除成功);失败 reject 携带可展示的错误文本。
 */
export async function deleteArchivedSessionRequest(sessionId: SessionId): Promise<void> {
  const response = await fetch('api/enterprise/sessions/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${readToken()}` },
    body: JSON.stringify({ sessionId }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${response.status} ${response.statusText}${text === '' ? '' : `: ${text}`}`)
  }
}

/**
 * 菜单行(order 50,菜单第一项):仅对已归档会话渲染。
 * @param props - owner 会话标识、座位标准面与注入面。
 * @returns 菜单行;未归档会话返回 null。
 */
export function DeleteSessionMenuItem({
  sessionId, displayTitle, useWorkspaces, useMenuOpenState, requestSessionDelete,
}: SessionDeleteMenuItemProps): ReactNode {
  const archived = useWorkspaces(snapshot => snapshot.archivedSessionIds.includes(sessionId))
  const [, setMenuOpen] = useMenuOpenState()
  if (!archived) return null
  return (
    <MenuItemButton
      danger
      icon={<IconTrashOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        requestSessionDelete(sessionId, displayTitle)
      }}
    >
      删除会话
    </MenuItemButton>
  )
}

/**
 * 悬停按钮(order 50,"..." 之前):仅对已归档会话渲染。
 * @param props - owner 会话标识、座位标准面与注入面。
 * @returns 图标按钮;未归档会话返回 null。
 */
export function DeleteSessionRowButton({
  sessionId, displayTitle, useWorkspaces, requestSessionDelete,
}: SessionDeleteRowActionProps): ReactNode {
  const archived = useWorkspaces(snapshot => snapshot.archivedSessionIds.includes(sessionId))
  if (!archived) return null
  return (
    <Tooltip label="删除会话" side="bottom" align="end" delayMs={500}>
      <button
        type="button"
        className={css.iconButton}
        aria-label="删除会话"
        onClick={() => { requestSessionDelete(sessionId, displayTitle) }}
      >
        <IconTrashOutlineRegular size={14} />
      </button>
    </Tooltip>
  )
}

/**
 * shell.overlay 条目:无待确认请求时渲染 null,否则每个请求一个对话框
 * (按会话 key 化,在途与错误状态随请求消亡)。
 * @param props - 请求 hook、结算与执行回调。
 * @returns 打开的确认对话框,或 null。
 */
export function DeleteSessionConfirmDialog({
  useDeleteRequest, settleSessionDelete, deleteSession,
}: SessionDeleteDialogProps): ReactNode {
  const request = useDeleteRequest(pending => pending)
  if (request === null) return null
  return (
    <DeleteConfirmForm
      key={request.sessionId}
      request={request}
      deleteSession={deleteSession}
      onSettle={settleSessionDelete}
    />
  )
}

/** 单个请求的确认对话框:在途与错误状态随请求消亡。 */
function DeleteConfirmForm({ request, deleteSession, onSettle }: {
  request: SessionDeleteRequest
  deleteSession: SessionDeleteDialogInjected['deleteSession']
  onSettle: () => void
}): ReactNode {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    if (deleting) return
    onSettle()
  }
  const confirm = () => {
    setDeleting(true)
    setError(null)
    deleteSession(request.sessionId).then(() => {
      setDeleting(false)
      onSettle()
    }).catch((reason: unknown) => {
      setDeleting(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel="关闭"
      title="删除会话"
      description={`将永久删除会话「${request.displayTitle}」的全部本地记录，此操作不可恢复。`}
      footer={(
        <>
          <Button variant="outline" disabled={deleting} onClick={close}>取消</Button>
          <Button variant="outline" className={css.deleteAction} disabled={deleting} onClick={confirm}>
            删除
          </Button>
        </>
      )}
    >
      {deleting && <div className={css.deleteStatus} role="status">正在删除…</div>}
      {error !== null && <div className={css.deleteError} role="alert">{error}</div>}
    </Modal>
  )
}
