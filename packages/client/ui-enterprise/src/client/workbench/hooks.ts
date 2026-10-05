/**
 * 工作台共享 Hooks:SnapshotStore 订阅桥 + 时间格式化。
 */
import { useSyncExternalStore } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'

/**
 * 订阅一个 SnapshotStore(useSyncExternalStore 直连;store 引用须稳定)。
 * @param store 工作台持有的快照 store。
 * @returns 当前快照。
 */
export function useSnapshot<T>(store: SnapshotStore<T>): T {
  return useSyncExternalStore(
    onStoreChange => store.subscribe(onStoreChange),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  )
}

/**
 * ISO 时间 → `MM-DD HH:mm` 短格式;解析失败原样返回。
 * @param iso ISO 时间字符串。
 * @returns 短格式时间文本。
 */
export function formatShortTime(iso: string): string {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  const date = new Date(time)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 两个 ISO 时间的时长 → `x分y秒` / `x秒`;缺失返回空串。
 * @param startIso 开始时间;null 返回空串。
 * @param endIso 结束时间;null 返回空串。
 * @returns 人读时长文本。
 */
export function formatDuration(startIso: string | null, endIso: string | null): string {
  if (startIso === null || endIso === null) return ''
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return ''
  const seconds = Math.round((end - start) / 1000)
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`
  return `${Math.floor(minutes / 60)}时${minutes % 60}分`
}

/**
 * 判断会话是否仍存活(用于完成回执列表的可点击性)。
 * @param byId 当前会话快照索引。
 * @param sessionId 目标会话 id。
 * @returns 会话存在于索引中时 true。
 */
export function sessionAlive(
  byId: Readonly<Record<SessionId, unknown>>, sessionId: SessionId,
): boolean {
  return Object.prototype.hasOwnProperty.call(byId, sessionId)
}
