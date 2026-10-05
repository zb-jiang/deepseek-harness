/**
 * Enterprise session knowledge-base context (design 2026-09-11 §6 补充): 员工端
 * 把「任务会话 → 所属应用」上报到本插件的本地路由,每个回合 step 1 向模型追加
 * 一条携带应用知识库 kbId 的可见块,使助手无需先经 '@' 插入文档即可调用
 * kb_search / kb_list / kb_read。
 *
 * <p>上报通道由客户端绑定状态驱动(EnterpriseWorkbench):新绑定、任务列表刷新
 * 后的持久绑定重放、完成解绑,各 POST 一批 {sessionId, applicationId} 到本插
 * 件的 exact 路由。映射存内存;webserver 重启后由客户端下一次重放自愈。
 * 伪造上报无法越权:解析知识库始终以当前登录员工的 JWT 调 web-console 按应用
 * 接口,非成员得到 404 → 不注入。
 *
 * <p>没有上报的会话(普通对话、未开通知识库应用的任务、applicationId 为 null)
 * 不注入任何内容。
 *
 * @module @deepseek-ai/dsh-kb-context
 */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { type ContextFormed } from '@deepseek-ai/dsh-llm'
export { KB_CONTEXT_SECTION, renderKbContextText } from './text.ts'
export type { KbBlockData } from './text.ts'
/** Cordis plugin name used by loader diagnostics. */
export declare const name = 'kb-context'
/** Services: local webserver (report route), login identity (JWT), agent scope events. */
export declare const inject: readonly ['webServer', 'currentUser', 'agents']
/** 插件配置。 */
export interface Config {
  /** web-console 基地址(协议+主机+端口,无路径);volatile:设置面板可改,即时生效。 */
  webConsoleBaseUrl: Volatile<string>
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
  webConsoleBaseUrl: z<string, string, 'volatile-defined'>
}>>, Schemastery.ObjectT<NoInfer<{
  webConsoleBaseUrl: z<string, string, 'volatile-defined'>
}>>>
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'kb-context': {
      kind: 'kb-context'
    } & ContextFormed
  }
}
/**
 * 插件装配:注册上报路由与每回合注入监听。
 * @param ctx - cordis 上下文。
 * @param config - 已校验配置。
 */
export declare function apply(ctx: Context, config: Config): void
//# sourceMappingURL=index.d.ts.map
