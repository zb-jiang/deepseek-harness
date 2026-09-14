/**
 * '@' 知识库文档触发源(design 2026-09-11 §6 第二期):待办会话里敲 '@'
 * 出现知识库文档候选,选中在输入框插入内联 chip(文档图标 + 文档名)。
 *
 * <p>候选解析链:会话 → 待办绑定(EnterpriseWorkbench)→ 应用 → 知识库
 * (KnowledgeWorkbench 缓存)→ 文档树(kbMenuTree 缓存,Modal 打开时
 * 刷新)。空 query 列全部解析 ready 的文档,非空按路径+文档名大小写不
 * 敏感过滤。候选 name=文档名(value=文档 id 是不透明 pick 载荷),仅作
 * 本源的展示与检索键,不参与 space/enter 裁决(本源不实现 match 钩子)。
 *
 * chip 的剪贴板投影与模型序列化都是 {@link kbReferenceText}
 * (`知识库文档 docid: <id>`,与 kb_read 工具的读取契约一致),发送时由
 * codec.serialize 逐 occurrence 展开,模型文本不因 chip 化变化。已知降级:
 * chip 只存在于编辑器文档,草稿持久化重载后还原为纯文本标记(与上游
 * @file 提及一致),chip 行不再显示,模型文本不受影响;历史消息与队列
 * 草稿里的纯文本标记经 kb-doc-decorator 恢复为文档徽标。
 */
import type { ClientSessionContext, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { EnterpriseWorkbench } from './enterprise-workbench.ts'
import { kbReferenceText, KB_SOURCE_NAME } from './knowledge-workbench.ts'
import type { KnowledgeWorkbench } from './knowledge-workbench.ts'
import type { KnowledgeBase } from './kb-api.ts'

/** 菜单里本源候选的分组标题(候选 section 原样渲染,不经字典)。 */
const SECTION_LABEL = '知识库文档'

/**
 * 解析会话的知识库:会话 → 待办绑定 → 应用 → 知识库(kbForApp 带缓存)。
 * @param workbench - 待办绑定来源。
 * @param knowledge - 应用→知识库解析。
 * @param sessionId - 目标会话。
 * @returns 知识库;非待办会话或应用未开通为 null(菜单不出候选)。
 */
export async function resolveSessionKb(
  workbench: EnterpriseWorkbench,
  knowledge: KnowledgeWorkbench,
  sessionId: ClientSessionContext['sessionId'],
): Promise<KnowledgeBase | null> {
  const taskId = workbench.bindings.getSnapshot().sessionToTask[sessionId]
  if (taskId === undefined) return null
  const task = workbench.tasks.getSnapshot().items.find(item => item.id === taskId)
  if (task === undefined || task.applicationId === null) return null
  return knowledge.kbForApp(task.applicationId)
}

/**
 * 构造 '@' 知识库文档触发源(apply 时注册一次,退订器由 ctx.effect 持有)。
 * @param deps - 两个工作台编排器(候选解析链的数据源)。
 * @returns 触发源。
 */
export function buildKbDocsSource(deps: {
  readonly workbench: EnterpriseWorkbench
  readonly knowledge: KnowledgeWorkbench
}): InputTriggerSource {
  const { workbench, knowledge } = deps
  return {
    trigger: '@',
    name: KB_SOURCE_NAME,
    order: 10,
    showGroupTitle: false,
    async candidates(session: ClientSessionContext, { query, signal }) {
      const kb = await resolveSessionKb(workbench, knowledge, session.sessionId)
      if (kb === null || signal.aborted) return []
      const tree = await knowledge.kbMenuTree(kb.id)
      if (signal.aborted) return []
      const needle = query.trim().toLowerCase()
      const folderPathById = new Map(tree.folders.map(folder => [folder.id, folder.path]))
      return tree.documents
        .filter(doc => doc.parseStatus === 'ready')
        .filter((doc) => {
          if (needle === '') return true
          const folderPath = doc.folderId !== null ? folderPathById.get(doc.folderId) : undefined
          return `${folderPath ?? ''}/${doc.name}`.toLowerCase().includes(needle)
        })
        .map((doc) => {
          const folderPath = doc.folderId !== null ? folderPathById.get(doc.folderId) : undefined
          return {
            name: doc.name,
            ...(folderPath === undefined ? {} : { description: folderPath }),
            icon: 'file' as const,
            section: SECTION_LABEL,
            value: doc.id,
          }
        })
    },
    warm(session) {
      void resolveSessionKb(workbench, knowledge, session.sessionId)
        .then(kb => (kb === null ? undefined : knowledge.kbMenuTree(kb.id)))
        .catch(() => { /* 会话诞生预热失败不阻塞;candidates 冷缓存会按需重拉 */ })
    },
    onPick({ candidate }) {
      const ref = candidate.value
      if (ref === undefined) return undefined
      return {
        insert: {
          source: KB_SOURCE_NAME,
          ref,
          label: candidate.label ?? candidate.name,
          appearance: 'file',
          clipboardText: kbReferenceText(ref),
        },
      }
    },
    codec: {
      clipboardText: kbReferenceText,
      serialize: ref => Promise.resolve(kbReferenceText(ref)),
    },
  }
}
