/**
 * 历史消息里的知识库文档徽标(design 2026-09-11 §6):把已发送用户消息与
 * 队列草稿里的 `知识库文档 docid: <id>` wire 文本恢复为文档徽标(文档图标
 * + 文档名)。
 *
 * <p>输入框 chip 发送后编辑器里只剩 wire 文本(草稿持久化的已知降级),
 * 历史气泡经 ui-primitives projectUserText 的自定义装饰器注册点按输入框
 * chip 的同一观感重投影;装饰只认服务端 UUID 形态的 docid,手工敲出的
 * 同形文本除外。徽标纯展示不可点,悬停 title 显示完整 wire 文本。docid
 * → 文档名经 web-console 文档元数据端点异步反查:成功名按 docid 进程内
 * 缓存,失败进 30s 负缓存,TTL 内降级显示 id 前 8 位、过期重试——瞬时
 * 失败(登录态刷新、web-console 不可达)不把徽标永久钉在降级态,文档
 * 删除/失权的稳定失败重试代价只是一次 404,不影响消息阅读。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ReferenceIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UserTextDecorationRange, UserTextDecorator } from '@deepseek-ai/dsh-client-ui-primitives'
import { getDocument } from './kb-api.ts'
import css from './KbDocChip.module.css'

/** wire 文本形态(knowledge-workbench.kbReferenceText 的字面契约,docid 为服务端 UUID)。 */
const KB_DOC_WIRE_RE =
  /知识库文档 docid: ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/gu

/** 已结算的 docid → 文档名(仅成功结果)。 */
const settledNames = new Map<string, string>()
/** 负缓存:docid → 失败结算时间;TTL 内降级不重试,过期重新出站。 */
const failedNames = new Map<string, number>()
const NEGATIVE_TTL_MS = 30_000
/** pending 表去重并发出站。 */
const pendingNames = new Map<string, Promise<string | null>>()

/** 负缓存是否仍在有效期内。 */
function failedRecently(docId: string): boolean {
  const failedAt = failedNames.get(docId)
  return failedAt !== undefined && Date.now() - failedAt < NEGATIVE_TTL_MS
}

/**
 * 反查文档名(缓存优先)。成功名永久缓存;失败只进短负缓存——瞬时失败
 * (登录态刷新、web-console 不可达)不应把徽标永久钉在降级态,文档删除/
 * 失权重试的代价只是一次 404。
 */
function resolveDocName(docId: string): Promise<string | null> {
  const settled = settledNames.get(docId)
  if (settled !== undefined) return Promise.resolve(settled)
  if (failedRecently(docId)) return Promise.resolve(null)
  const pending = pendingNames.get(docId)
  if (pending !== undefined) return pending
  const inflight = getDocument(docId)
    .then((doc) => {
      settledNames.set(docId, doc.name)
      return doc.name as string | null
    })
    .catch(() => {
      failedNames.set(docId, Date.now())
      return null
    })
    .finally(() => { pendingNames.delete(docId) })
  pendingNames.set(docId, inflight)
  return inflight
}

/** 名称解析的同步快照:已结算返回名称(null = 负缓存内确认失败),未结算 undefined。 */
function settledDocName(docId: string): string | null | undefined {
  const settled = settledNames.get(docId)
  if (settled !== undefined) return settled
  return failedRecently(docId) ? null : undefined
}

/** 名称未结算时的降级展示(id 前 8 位足以区分同屏徽标,完整 id 在 title 里)。 */
function fallbackLabel(docId: string): string {
  return `文档 ${docId.slice(0, 8)}`
}

/** 历史消息里的单个知识库文档徽标(纯展示;名称异步反查,先出降级文本)。 */
function KbDocChip({ docId, title }: { docId: string; title: string }): ReactNode {
  const [name, setName] = useState<string | null | undefined>(() => settledDocName(docId))
  useEffect(() => {
    if (settledDocName(docId) !== undefined) return undefined
    let alive = true
    void resolveDocName(docId).then((resolved) => {
      if (alive) setName(resolved)
    })
    return () => { alive = false }
  }, [docId])
  return (
    <span className={css.chip} title={title} data-kb-doc-chip={docId}>
      <ReferenceIcon kind="file" size={16} className={css.icon} />
      {name ?? fallbackLabel(docId)}
    </span>
  )
}

/**
 * 构造知识库文档装饰器(apply 时经 registerUserTextDecorator 注册一次,
 * 退订器由 ctx.effect 持有)。
 */
export function buildKbDocDecorator(): UserTextDecorator {
  return {
    name: 'kbDocs',
    find(text: string) {
      KB_DOC_WIRE_RE.lastIndex = 0
      const ranges: UserTextDecorationRange[] = []
      let wire: RegExpExecArray | null
      while ((wire = KB_DOC_WIRE_RE.exec(text)) !== null) {
        ranges.push({ start: wire.index, end: wire.index + wire[0].length, title: wire[0] })
      }
      return ranges
    },
    render(range, matchedText) {
      const wire = /^知识库文档 docid: ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/u
        .exec(matchedText)
      if (wire === null) return matchedText
      return <KbDocChip docId={wire[1] as string} title={range.title ?? matchedText} />
    },
  }
}
