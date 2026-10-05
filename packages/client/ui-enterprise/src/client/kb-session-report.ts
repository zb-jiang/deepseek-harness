/**
 * 待办会话知识库归属上报(员工端 → 本地 kb-context 插件):把
 * {sessionId, applicationId} POST 到本地 webserver 的 exact 路由
 * `/api/enterprise/kb/session-context`(kb-context 插件自有路由,不经
 * kb-api.ts 的 web-console 代理)。上报是尽力而为:失败只损失下一轮的
 * kb 注入,由下一次重放/重绑自愈,因此错误静默降级,不打断工作台。
 * 归属覆盖进行中与已完成会话:任务提交完成后归属保留(applicationId 不
 * 清 null),已完成会话继续注入 kb 块、选择器入口继续可用。
 */

import { readToken } from './task-api.ts'

/** 一条会话归属:applicationId 为 null 表示客户端明确解除归属(会话与应用解绑/无应用)。 */
export interface SessionKbEntry {
  readonly sessionId: string
  readonly applicationId: string | null
}

/** 上报路由键(本地 kb-context 插件注册的 exact 路径;浏览器侧请求时去前导斜杠)。 */
const REPORT_PATH = '/api/enterprise/kb/session-context'

/**
 * 上报会话归属(fire-and-forget;未登录静默跳过)。
 * @param entries - 本批上报条目(持久绑定重放时批量)。
 */
export function reportSessionKb(entries: readonly SessionKbEntry[]): void {
  const token = readToken()
  if (token === null) return
  void fetch(REPORT_PATH.slice(1), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ entries }),
  }).catch((error: unknown) => {
    console.warn('kb 会话归属上报失败(下一次重放自愈)', error)
  })
}
