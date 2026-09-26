/**
 * Workspace picker dialog: explicit workspace binding for a task.
 *
 * <p>首次点击未绑定待办时由 TaskQueueSidebar 渲染(workbench.openTask 置
 * pendingTask):员工从工作区列表中单选,或点"浏览本地文件夹"经宿主目录
 * 选择器(桌面版为 OS 原生对话框)现选一个目录,选定即注册为新工作区并
 * 自动选中;确认后 workbench 才新建专属会话并绑定。弹窗明示"选定后不可
 * 修改"——绑定即最终决定,没有草稿期反悔通道;取消不产生任何会话,可重新
 * 点击待办再次选择。尚无任何工作区时列表退化为引导视图,同样走浏览入口。
 */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { Task } from './task-api.ts'
import type { WorkspacePickResult } from './enterprise-workbench.ts'
import css from './WorkspacePickerDialog.module.css'

type WorkspacePickerDialogProps = {
  open: boolean
  /** 等待选择工作空间的待办(null 时弹窗不渲染内容)。 */
  task: Task | null
  /** 当前工作区列表(经 useWorkspaces 订阅,创建/删除后实时刷新)。 */
  workspaces: readonly WorkspaceView[]
  onClose: () => void
  onConfirm: (workspaceId: WorkspaceId) => void
  /** 打开宿主目录选择器浏览本地文件夹,选定即注册为新工作区。 */
  onBrowse: () => Promise<WorkspacePickResult>
}

export function WorkspacePickerDialog({
  open, task, workspaces, onClose, onConfirm, onBrowse,
}: WorkspacePickerDialogProps) {
  const [selected, setSelected] = useState<WorkspaceId | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const hasWorkspaces = workspaces.length > 0

  const browse = (): void => {
    if (browsing) return
    setBrowsing(true)
    setBrowseError(null)
    void onBrowse().then((result) => {
      setBrowsing(false)
      if (result.status === 'picked') setSelected(result.workspaceId)
      if (result.status === 'error') setBrowseError(result.message)
    })
  }

  return (
    <Modal open={open} onClose={onClose} title="选择工作空间" headless={true} className={css.modal ?? ''}>
      {task !== null && (
        <div className={css.dialog}>
          <div className={css.header}>
            <h3 className={css.title}>为「{task.name ?? task.id}」选择工作空间</h3>
            <p className={css.subtitle}>
              将在该工作空间中创建本任务的专属 AI 会话
            </p>
          </div>

          {hasWorkspaces ? (
            <div className={css.list} role="radiogroup" aria-label="工作空间列表">
              {workspaces.map(workspace => (
                <label
                  key={workspace.workspaceId}
                  className={`${css.option} ${selected === workspace.workspaceId ? css.optionSelected ?? '' : ''}`}
                >
                  <input
                    type="radio"
                    name="workspace-picker"
                    className={css.radio}
                    checked={selected === workspace.workspaceId}
                    onChange={() => { setSelected(workspace.workspaceId) }}
                  />
                  <span className={css.optionMain}>
                    <span className={css.optionTitle}>{workspace.title}</span>
                    <span className={css.optionPath} title={workspace.path}>{workspace.path}</span>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <div className={css.empty}>
              <span>尚无可用工作空间 —— 浏览本地文件夹选定一个目录即创建,再确认处理该待办。</span>
            </div>
          )}

          <button type="button" className={css.browse} onClick={browse} disabled={browsing}>
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
              <path
                d="M1.5 3.5a1 1 0 0 1 1-1h3l1.5 1.8h6.5a1 1 0 0 1 1 1v7.2a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
                fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"
              />
            </svg>
            <span>{browsing ? '等待选择文件夹…' : '浏览本地文件夹…'}</span>
          </button>
          {browseError !== null && <div className={css.browseError}>{browseError}</div>}

          <div className={css.warning}>
            <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
              <path d="M10 3.5 18 16.5H2L10 3.5Z" strokeLinejoin="round" />
              <path d="M10 8.5v3.6" strokeLinecap="round" />
              <circle cx="10" cy="14.4" r="0.9" fill="currentColor" stroke="none" />
            </svg>
            <span>工作空间选定后不可修改:本任务的所有对话与档案将固定在该工作空间。</span>
          </div>

          <div className={css.actions}>
            <Button variant="outline" onClick={onClose}>取消</Button>
            <Button
              disabled={!hasWorkspaces || selected === null}
              onClick={() => { if (selected !== null) onConfirm(selected) }}
            >
              确认并进入会话
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
