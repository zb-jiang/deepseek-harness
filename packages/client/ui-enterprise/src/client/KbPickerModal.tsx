/**
 * 知识库选择器 Modal(design 2026-09-11 §6 会话内选择器)。
 *
 * <p>打开时加载知识库全树(文件夹 + 递归文档),文件夹按层展开、文档行
 * 多选(checkbox);搜索框切换平铺搜索结果(仅解析 ready)。确认后经
 * KnowledgeWorkbench.insertSelections 把文档作为 kbDocs chip 追加到输入
 * 框草稿末尾(不自动提交)并关闭;取消/遮罩点击直接关闭不写入。Modal
 * 不预选已有 chips(确认是纯增量选择,存量 chip 的移除在 chip 行操作)。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { KnowledgeWorkbench, KbSelection } from './knowledge-workbench.ts'
import type { KbDocument, KbFolder, KnowledgeBase } from './kb-api.ts'
import css from './KbPickerModal.module.css'

/** 文件夹树节点(平铺 folders 组装,children 已按名排序)。 */
interface FolderNode {
  readonly folder: KbFolder
  readonly children: FolderNode[]
}

/**
 * 平铺文件夹组树:parentId 挂父,缺失/根挂根;每层按名排序。
 * @param folders - 服务端平铺返回的全部文件夹。
 * @returns 根层节点列表。
 */
export function buildFolderTree(folders: readonly KbFolder[]): FolderNode[] {
  const nodes = new Map<string, FolderNode>(folders.map(folder => [folder.id, { folder, children: [] }]))
  const roots: FolderNode[] = []
  for (const node of nodes.values()) {
    const parent = node.folder.parentId !== null ? nodes.get(node.folder.parentId) : undefined
    if (parent !== undefined && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  const sortLevel = (list: FolderNode[]): void => {
    list.sort((left, right) => left.folder.name.localeCompare(right.folder.name))
    for (const child of list) sortLevel(child.children)
  }
  sortLevel(roots)
  return roots
}

/** 文档在树中的物化路径(根下 /name;文件夹 path 前缀 + 名)。 */
function docPathOf(doc: KbDocument, folderPathById: ReadonlyMap<string, string>): string {
  const folderPath = doc.folderId !== null ? folderPathById.get(doc.folderId) : undefined
  return folderPath !== undefined ? `${folderPath}/${doc.name}` : `/${doc.name}`
}

/** 解析状态的人读短标签。 */
function parseStatusText(status: KbDocument['parseStatus']): string {
  switch (status) {
    case 'pending': return '解析中'
    case 'failed': return '解析失败'
    default: return ''
  }
}

/** 一个文档行:checkbox + 名称 + 解析状态;选中状态由父层持有。 */
function DocRow({ doc, path, checked, onToggle }: {
  doc: KbDocument
  path: string
  checked: boolean
  onToggle: (doc: KbDocument) => void
}): ReactNode {
  const status = parseStatusText(doc.parseStatus)
  return (
    <li className={css.item}>
      <label className={css.docRow} title={doc.textExcerpt === '' ? path : `${path}\n${doc.textExcerpt}`}>
        <input
          type="checkbox"
          className={css.checkbox}
          checked={checked}
          onChange={() => { onToggle(doc) }}
        />
        <span className={css.docName}>{doc.name}</span>
        {status !== '' && <span className={doc.parseStatus === 'failed' ? css.statusFailed : css.statusPending}>{status}</span>}
      </label>
    </li>
  )
}

/** 一个文件夹行:展开箭头 + 名称;展开后先文档后子文件夹。 */
function FolderRow({ node, documentsByFolder, folderPathById, selected, onToggle, expanded, onExpand }: {
  node: FolderNode
  documentsByFolder: ReadonlyMap<string | null, readonly KbDocument[]>
  folderPathById: ReadonlyMap<string, string>
  selected: ReadonlySet<string>
  onToggle: (doc: KbDocument) => void
  expanded: ReadonlySet<string>
  onExpand: (folderId: string) => void
}): ReactNode {
  const isOpen = expanded.has(node.folder.id)
  const docs = documentsByFolder.get(node.folder.id) ?? []
  return (
    <li className={css.item}>
      <button type="button" className={css.folderRow} aria-expanded={isOpen} onClick={() => { onExpand(node.folder.id) }}>
        <span className={`${css.chevron} ${isOpen ? css.chevronOpen : ''}`} aria-hidden>
          <svg viewBox="0 0 14 14" width="10" height="10">
            <path d="M4 2.5 9.5 7 4 11.5z" fill="currentColor" />
          </svg>
        </span>
        <span className={css.folderName}>{node.folder.name}</span>
      </button>
      {isOpen && (
        <ul className={css.level}>
          {docs.map(doc => (
            <DocRow
              key={doc.id}
              doc={doc}
              path={docPathOf(doc, folderPathById)}
              checked={selected.has(doc.id)}
              onToggle={onToggle}
            />
          ))}
          {node.children.map(child => (
            <FolderRow
              key={child.folder.id}
              node={child}
              documentsByFolder={documentsByFolder}
              folderPathById={folderPathById}
              selected={selected}
              onToggle={onToggle}
              expanded={expanded}
              onExpand={onExpand}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/** 选择器 Modal 的 props。 */
export type KbPickerModalProps = {
  open: boolean
  kb: KnowledgeBase
  sessionId: SessionId
  knowledge: KnowledgeWorkbench
  onClose: () => void
}

/** 知识库选择器 Modal(见模块文档)。 */
export function KbPickerModal({ open, kb, sessionId, knowledge, onClose }: KbPickerModalProps) {
  const [tree, setTree] = useState<{ folders: KbFolder[]; documents: KbDocument[] } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [kw, setKw] = useState('')
  const [searchResults, setSearchResults] = useState<KbDocument[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<Map<string, KbSelection>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return undefined
    let alive = true
    setTree(null)
    setError(null)
    setKw('')
    setSearchResults(null)
    setSelected(new Map())
    setExpanded(new Set())
    setLoading(true)
    knowledge.loadKbTree(kb.id).then(
      (data) => {
        if (!alive) return
        setTree(data)
        setLoading(false)
      },
      (e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      },
    )
    return () => { alive = false }
  }, [open, kb.id, knowledge])

  const folderPathById = useMemo(
    () => new Map((tree?.folders ?? []).map(folder => [folder.id, folder.path])),
    [tree],
  )
  const documentsByFolder = useMemo(() => {
    const map = new Map<string | null, KbDocument[]>()
    for (const doc of tree?.documents ?? []) {
      const list = map.get(doc.folderId)
      if (list === undefined) map.set(doc.folderId, [doc])
      else list.push(doc)
    }
    return map
  }, [tree])
  const folderTree = useMemo(() => buildFolderTree(tree?.folders ?? []), [tree])
  const rootDocs = documentsByFolder.get(null) ?? []

  const toggleSelect = (doc: KbDocument): void => {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(doc.id)) next.delete(doc.id)
      else next.set(doc.id, { doc, path: docPathOf(doc, folderPathById) })
      return next
    })
  }

  const toggleExpand = (folderId: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  const doSearch = async (): Promise<void> => {
    const query = kw.trim()
    if (query === '') {
      setSearchResults(null)
      return
    }
    setSearching(true)
    setError(null)
    try {
      setSearchResults(await knowledge.searchDocuments(kb.id, query))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSearching(false)
    }
  }

  const confirm = (): void => {
    if (selected.size === 0) return
    if (!knowledge.insertSelections(sessionId, [...selected.values()])) {
      setError('未能附加到输入框，请重试')
      return
    }
    onClose()
  }

  const selectedIds = new Set(selected.keys())
  const empty = !loading
    && searchResults === null
    && rootDocs.length === 0
    && folderTree.length === 0
  const searchEmpty = !loading && searchResults !== null && searchResults.length === 0

  return (
    <Modal open={open} onClose={onClose} title="选择知识库文档" headless={true} className={css.modal ?? ''}>
      <div className={css.dialog}>
        <div className={css.header}>
          <h3 className={css.title}>选择知识库文档</h3>
          <p className={css.subtitle}>{kb.name} — 勾选需要 AI 参考的文档，确认后以文档标记附加到输入框</p>
        </div>
        <form
          className={css.searchBar}
          onSubmit={(e) => {
            e.preventDefault()
            void doSearch()
          }}
        >
          <Input
            value={kw}
            onChange={(e) => { setKw(e.target.value) }}
            placeholder="搜索文档（仅解析就绪的文档）"
            className={css.searchInput ?? ''}
          />
          <Button variant="outline" size="sm" type="submit" disabled={searching}>
            {searching ? '搜索中…' : '搜索'}
          </Button>
          {searchResults !== null && (
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => {
                setKw('')
                setSearchResults(null)
              }}
            >
              返回目录
            </Button>
          )}
        </form>
        {error !== null && <div className={css.error}>{error}</div>}
        <div className={css.body}>
          {loading && <div className={css.hint}>加载中…</div>}
          {empty && <div className={css.hint}>知识库暂无文档</div>}
          {searchEmpty && <div className={css.hint}>无匹配文档</div>}
          {!loading && searchResults !== null && (
            <ul className={css.list}>
              {searchResults.map(doc => (
                <DocRow
                  key={doc.id}
                  doc={doc}
                  path={docPathOf(doc, folderPathById)}
                  checked={selectedIds.has(doc.id)}
                  onToggle={toggleSelect}
                />
              ))}
            </ul>
          )}
          {!loading && searchResults === null && (rootDocs.length > 0 || folderTree.length > 0) && (
            <ul className={css.list}>
              {rootDocs.map(doc => (
                <DocRow
                  key={doc.id}
                  doc={doc}
                  path={docPathOf(doc, folderPathById)}
                  checked={selectedIds.has(doc.id)}
                  onToggle={toggleSelect}
                />
              ))}
              {folderTree.map(node => (
                <FolderRow
                  key={node.folder.id}
                  node={node}
                  documentsByFolder={documentsByFolder}
                  folderPathById={folderPathById}
                  selected={selectedIds}
                  onToggle={toggleSelect}
                  expanded={expanded}
                  onExpand={toggleExpand}
                />
              ))}
            </ul>
          )}
        </div>
        <div className={css.actions}>
          <span className={css.count}>已选 {selected.size} 篇</span>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={selected.size === 0} onClick={confirm}>确认选择</Button>
        </div>
      </div>
    </Modal>
  )
}
