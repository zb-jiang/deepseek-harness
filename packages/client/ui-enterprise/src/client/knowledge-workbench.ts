/**
 * 知识库工作台控制器(design 2026-09-11 §6 员工端):应用→知识库缓存、
 * 选择器数据源、'@' 菜单文档树缓存、确认选择到输入框的 chip 插入与移除。
 *
 * <p>应用→知识库的解析结果(含"未开通"的 null)按 appId 缓存,待办定位
 * 知识库不重复出站。文档树缓存按 kbId 存 Promise(并发调用共享同一次
 * 出站,拒绝即逐出),选择器 Modal 每次打开经 loadKbTree 拉最新并刷新
 * 缓存,'@' 菜单经 kbMenuTree 读缓存。
 *
 * <p>会话选中文档的单一事实源是输入框编辑器里的 reference chip
 * (source=kbDocs,ref=文档 id);InputState.occurrences 是其投影,输入框
 * 上方 chip 行直接由其派生。确认选择经 scoped bail 事件
 * 'slash/input-insert-reference' 在草稿末尾零长 span 插入 chip(插入与
 * 快照读取同步执行,span-CAS 保护);移除经 'slash/input-consume-token'
 * 删除 chip 的 detect span。发送时每个 occurrence 由触发源 codec 序列化
 * 为 {@link kbReferenceText},模型文本与 kb_read 契约不变。草稿持久化
 * 重载后 chip 还原为纯文本标记(上游 @file 提及同款降级),chip 行不再
 * 显示,模型文本不受影响。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IConversation, SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { getKbByApp, listDocuments, listFolders } from './kb-api.ts'
import type { KbDocument, KbFolder, KnowledgeBase } from './kb-api.ts'

/** 输入框 reference chip 的源名(occurrences 过滤键;触发源同名注册)。 */
export const KB_SOURCE_NAME = 'kbDocs'

/**
 * chip 的剪贴板/模型投影(草稿文本形态;与 kb_read 工具的读取契约一致)。
 * @param ref - 文档 id(occurrence.ref,服务端 UUID)。
 */
export function kbReferenceText(ref: string): string {
  return `知识库文档 docid: ${ref}`
}

/** 控制器依赖的跨插件服务面(sessions/conversation:注入消息的输入面)。 */
export interface KnowledgeDeps {
  readonly sessions: ISessions
  readonly conversation: IConversation
}

/** 一篇选中文档:文档元数据 + 在文件夹树中的物化路径(根下为 /name)。 */
export interface KbSelection {
  readonly doc: KbDocument
  readonly path: string
}

/** 知识库文档树('@' 菜单与选择器 Modal 共用)。 */
export type KbTree = { folders: KbFolder[]; documents: KbDocument[] }

/**
 * 知识库工作台编排器。apply 时构造一次,经插槽 inject 面分发;输入框
 * chip 的读取走座位注入的 InputState(零自有状态),这里只持有跨会话
 * 缓存与出入站编排。
 */
export class KnowledgeWorkbench {
  /** 应用 → 知识库缓存(null = 已确认未开通)。 */
  private readonly kbByApp = new Map<string, KnowledgeBase | null>()
  /** 文档树缓存(kbId → in-flight/已结 Promise)。 */
  private readonly treeByKb = new Map<string, Promise<KbTree>>()
  private readonly deps: KnowledgeDeps

  /**
   * @param deps - 跨插件服务面(sessions/conversation)。
   */
  constructor(deps: KnowledgeDeps) {
    this.deps = deps
  }

  /**
   * 解析应用的知识库(带缓存;待办定位知识库的入口)。
   * @param appId - 待办 Task.applicationId。
   * @returns 知识库;应用未开通为 null(调用方隐藏知识库入口)。
   */
  async kbForApp(appId: string): Promise<KnowledgeBase | null> {
    const cached = this.kbByApp.get(appId)
    if (cached !== undefined) return cached
    const kb = await getKbByApp(appId)
    this.kbByApp.set(appId, kb)
    return kb
  }

  /**
   * 知识库全树(文件夹 + 递归全部文档):拉最新并刷新菜单缓存。选择器
   * Modal 每次打开调用,保证看到刚上传的文档;'@' 菜单读同一份缓存。
   * @param kbId - 知识库 id。
   */
  loadKbTree(kbId: string): Promise<KbTree> {
    const pending = Promise.all([
      listFolders(kbId),
      listDocuments(kbId, { recursive: true }),
    ]).then(([folders, documents]) => ({ folders, documents }))
    this.treeByKb.set(kbId, pending)
    pending.catch(() => {
      // 失败不驻留缓存:菜单下次冷缓存重拉,Modal 打开流程自行向用户报错。
      if (this.treeByKb.get(kbId) === pending) this.treeByKb.delete(kbId)
    })
    return pending
  }

  /**
   * '@' 菜单的文档树(缓存优先,miss 才拉;并发调用共享同一 Promise)。
   * @param kbId - 知识库 id。
   */
  kbMenuTree(kbId: string): Promise<KbTree> {
    return this.treeByKb.get(kbId) ?? this.loadKbTree(kbId)
  }

  /**
   * 关键字检索文档(仅解析 ready;选择器搜索框数据源)。
   * @param kbId - 知识库 id。
   * @param kw - 关键字。
   */
  async searchDocuments(kbId: string, kw: string): Promise<KbDocument[]> {
    return listDocuments(kbId, { kw })
  }

  /**
   * 确认选择:把每篇文档作为 kbDocs chip 追加到输入框草稿末尾(不自动
   * 提交,由员工自行编辑后发送)。同会话已有 chip 按 occurrence.ref 去重
   * 跳过;草稿已有内容时附加在末尾,不覆盖已编辑内容。
   * @param sessionId - 目标会话。
   * @param selections - 本次确认选中的文档(含树路径;路径仅展示用)。
   * @returns 是否全部插入成功(会话输入面不可达或插入被拒为 false,
   * 调用方提示并保持弹窗)。
   */
  insertSelections(sessionId: SessionId, selections: readonly KbSelection[]): boolean {
    if (selections.length === 0) return true
    const actx = this.deps.sessions.scope(sessionId)
    if (actx === undefined) return false
    const input = this.deps.conversation.input.for(actx)
    const existing = new Set(
      input.state.getSnapshot().occurrences
        .filter(occurrence => occurrence.source === KB_SOURCE_NAME)
        .map(occurrence => occurrence.ref),
    )
    let all = true
    for (const { doc } of selections) {
      if (existing.has(doc.id)) continue
      existing.add(doc.id)
      if (!this.insertKbChip(actx, input, doc.id, doc.name)) all = false
    }
    return all
  }

  /**
   * 移除会话输入框里的一个文档 chip:删除编辑器里的 chip 节点,草稿文本
   * 同步收缩(已发送消息不撤回)。chip 在 detect 投影里占 1 字符,其
   * detect 偏移由 occurrences(clipboard 坐标)折叠求出。
   * @param sessionId - 目标会话。
   * @param docId - 要移除的文档 id。
   */
  removeSelection(sessionId: SessionId, docId: string): void {
    const actx = this.deps.sessions.scope(sessionId)
    if (actx === undefined) return
    const input = this.deps.conversation.input.for(actx)
    const snap = input.state.getSnapshot()
    let shrink = 0
    for (const occurrence of snap.occurrences) {
      const detectStart = occurrence.offset - shrink
      if (occurrence.source === KB_SOURCE_NAME && occurrence.ref === docId) {
        actx.bail(actx, 'slash/input-consume-token', {
          guard: { kind: 'span', span: { start: detectStart, end: detectStart + 1, draftRev: snap.draftRev } },
        })
        return
      }
      shrink += occurrence.length - 1
    }
  }

  /**
   * 在草稿末尾插入一个 kbDocs chip(零长 span + span-CAS)。快照读取与
   * bail 同步执行,中间无 await,rev 不会漂移;输入面在提交等忙碌相位
   * 拒收(bail 返回 false)。
   */
  private insertKbChip(actx: Context, input: SessionInput, ref: string, label: string): boolean {
    const snap = input.state.getSnapshot()
    // chip 在 detect 投影占 1 字符;草稿(clipboard 投影)按 clipboardText
    // 展开,草稿末尾的 detect 偏移 = 草稿长度 − 已有 chip 的展开膨胀。
    const end = snap.draft.length - snap.occurrences.reduce((n, o) => n + o.length - 1, 0)
    return actx.bail(actx, 'slash/input-insert-reference', {
      reference: {
        source: KB_SOURCE_NAME,
        ref,
        label,
        appearance: 'file',
        clipboardText: kbReferenceText(ref),
      },
      span: { start: end, end, draftRev: snap.draftRev },
    }) === true
  }
}
