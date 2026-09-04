/**
 * Full-screen overlay that hosts the enterprise task workbench.
 *
 * <p>Registered into {@code shell.overlay} and toggled from the sidebar nav.
 */
import { useSyncExternalStore } from 'react'
import { closeTaskPanel, getTaskPanelSnapshot, subscribeTaskPanel } from './enterprise-task-store.ts'
import { EnterpriseTaskPanel } from './EnterpriseTaskPanel.tsx'
import css from './TaskOverlay.module.css'

export function TaskOverlay() {
  const { open } = useSyncExternalStore(subscribeTaskPanel, getTaskPanelSnapshot, getTaskPanelSnapshot)

  if (!open) return null

  return (
    <div className={css.overlay}>
      <div className={css.header}>
        <span className={css.title}>企业流程待办工作台</span>
        <button type="button" className={css.close} onClick={closeTaskPanel}>×</button>
      </div>
      <div className={css.body}>
        <EnterpriseTaskPanel />
      </div>
    </div>
  )
}
