/**
 * Lightweight module-level store for toggling the enterprise task panel overlay.
 *
 * <p>This is an internal UI state surface (show/hide the task workbench), not
 * business state, so a module-level snapshot store is sufficient and matches
 * the existing auth snapshot pattern in this plugin.
 */

type TaskPanelSnapshot = { open: boolean }

let snapshot: TaskPanelSnapshot = { open: false }
const listeners = new Set<() => void>()

function publish(next: TaskPanelSnapshot): void {
  snapshot = next
  listeners.forEach((fn) => { fn() })
}

export function subscribeTaskPanel(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function getTaskPanelSnapshot(): TaskPanelSnapshot {
  return snapshot
}

export function openTaskPanel(): void {
  publish({ open: true })
}

export function closeTaskPanel(): void {
  publish({ open: false })
}

export function toggleTaskPanel(): void {
  publish({ open: !snapshot.open })
}
