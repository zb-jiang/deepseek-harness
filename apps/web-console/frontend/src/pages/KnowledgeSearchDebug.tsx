import { App, Button, Drawer, Empty, Input, InputNumber, Spin, Tag, Tooltip, Typography } from 'antd'
import { ExperimentOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SearchOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useState } from 'react'
import {
  type KbAppSummary,
  type KbSearchHitDto,
  type KbSearchTraceDto,
  type KbTraceCandidate,
  type KbTraceDoc,
  type KbTracePath,
  type KbTraceRerank,
  kbApi,
} from '../api/kb'
import './KnowledgeSearchDebug.css'

/**
 * 知识库三路混合检索 debug 可视化:选知识库 → 输入查询 → 图形展示
 * 「查询向量化 → 三路候选 → RRF 融合 → rerank 精排 → 最终 topK」全过程,点击任意
 * 候选/结果行弹出打分明细抽屉。每次执行会真实调用一次查询向量化与 rerank(硅基流动)。
 */

/** 三路语义色与展示名(泳道、贡献条、抽屉全程一致)。 */
const PATH_META: Record<KbTracePath['path'], { label: string; color: string }> = {
  vector: { label: '向量路', color: '#0ea5e9' },
  keyword: { label: '关键词路', color: '#f59e0b' },
  fts: { label: '全文路', color: '#10b981' },
}

/**
 * 抽屉状态按流水线阶段拆分,每个入口只展示本阶段信息:
 * candidate=三路候选行;vector-agg=向量路文档聚合;rrf=融合结果泳道行;
 * rerank=重排泳道行;final=最终结果行。
 */
type DetailState =
  | { kind: 'candidate'; path: KbTracePath; candidate: KbTraceCandidate }
  | { kind: 'vector-agg'; doc: KbTraceDoc }
  | { kind: 'rrf'; doc: KbTraceDoc; index: number }
  | { kind: 'rerank'; row: KbTraceRerank; index: number }
  | { kind: 'final'; hit: KbSearchHitDto; doc: KbTraceDoc | null; index: number }
  | null

function fmt(n: number, digits = 4): string {
  return n.toFixed(digits)
}

export default function KnowledgeSearchDebug() {
  const { message } = App.useApp()
  const [kbs, setKbs] = useState<KbAppSummary[]>([])
  const [kbLoading, setKbLoading] = useState(true)
  const [selectedKbId, setSelectedKbId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [topK, setTopK] = useState<number | null>(8)
  const [searching, setSearching] = useState(false)
  const [trace, setTrace] = useState<KbSearchTraceDto | null>(null)
  const [detail, setDetail] = useState<DetailState>(null)
  const [sideCollapsed, setSideCollapsed] = useState(false)

  useEffect(() => {
    kbApi.listMine()
      .then((list) => {
        setKbs(list)
        if (list.length === 1) setSelectedKbId(list[0].kbId)
      })
      .catch((e: Error) => message.error(e.message))
      .finally(() => setKbLoading(false))
  }, [message])

  const selectedKb = kbs.find(k => k.kbId === selectedKbId) ?? null

  const runSearch = async () => {
    if (!selectedKbId) {
      message.warning('请先在左侧选择一个知识库')
      return
    }
    if (!query.trim()) {
      message.warning('请输入查询文本')
      return
    }
    setSearching(true)
    try {
      const result = await kbApi.searchDebug(selectedKbId, { query: query.trim(), topK: topK ?? undefined })
      setTrace(result)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSearching(false)
    }
  }

  // 贡献条按总分占比缩放,第一名占满轨道
  const maxDocScore = useMemo(
    () => trace?.docs.reduce((max, d) => Math.max(max, d.totalScore), 0) ?? 0,
    [trace],
  )

  // rerank 生效判定:候选池中存在非空重排分(全为 null = 本次调用失败降级)
  const rerankActive = trace?.rerankPool.some(r => r.rerankScore !== null) ?? false

  // 向量路两阶段展示:chunk 行按文档聚合(文档分 = Σ 1/(60+块名次)),
  // 聚合结果与词法两路的文档级候选对齐;顺序按聚合分降序
  const vectorAgg = useMemo(() => {
    if (!trace) return []
    const chunks = trace.paths.find(p => p.path === 'vector')?.candidates ?? []
    const byDoc = new Map<string, { docId: string; docName: string; agg: number; blocks: number }>()
    for (const c of chunks) {
      const cur = byDoc.get(c.docId)
      if (cur) {
        cur.agg += c.rrfScore
        cur.blocks += 1
      } else {
        byDoc.set(c.docId, { docId: c.docId, docName: c.docName, agg: c.rrfScore, blocks: 1 })
      }
    }
    return [...byDoc.values()].sort((a, b) => b.agg - a.agg)
  }, [trace])

  const detailTitle = detail
    ? detail.kind === 'candidate'
      ? `候选明细 · ${PATH_META[detail.path.path].label}`
      : detail.kind === 'vector-agg'
        ? `向量路聚合明细 · ${detail.doc.docName}`
        : detail.kind === 'rrf'
          ? `RRF 融合明细 · ${detail.doc.docName}`
          : detail.kind === 'rerank'
            ? `rerank 精排明细 · ${detail.row.docName}`
            : `最终结果明细 · ${detail.hit.docName}`
    : ''

  return (
    <div className="kb-debug-page">
      <div className={`kb-debug-side${sideCollapsed ? ' collapsed' : ''}`}>
        <div className="kb-debug-side-head">
          {sideCollapsed ? (
            <Button
              type="text"
              size="small"
              icon={<MenuUnfoldOutlined />}
              title="展开知识库列表"
              onClick={() => setSideCollapsed(false)}
            />
          ) : (
            <>
              <span className="kb-debug-side-title">知识库</span>
              <span className="kb-debug-side-right">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{kbs.length} 个</Typography.Text>
                <Button
                  type="text"
                  size="small"
                  icon={<MenuFoldOutlined />}
                  title="折叠知识库列表"
                  onClick={() => setSideCollapsed(true)}
                />
              </span>
            </>
          )}
        </div>
        <div className="kb-debug-side-list">
          {kbLoading ? (
            <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
          ) : kbs.length === 0 ? (
            <Empty description="没有可见的知识库" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            kbs.map(kb => (
              <div
                key={kb.kbId}
                className={`kb-debug-kb-item${kb.kbId === selectedKbId ? ' selected' : ''}`}
                onClick={() => { setSelectedKbId(kb.kbId); setTrace(null) }}
              >
                <div className="kb-debug-kb-app">{kb.applicationName}</div>
                <div className="kb-debug-kb-name">{kb.kbName}</div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="kb-debug-main">
        <div className="kb-debug-querybar">
          {selectedKb && (
            <Tag color="#4d5cf5" style={{ marginInlineEnd: 0 }}>
              {selectedKb.applicationName} / {selectedKb.kbName}
            </Tag>
          )}
          <Input
            placeholder="输入查询文本,展示三路召回 → RRF 融合 → rerank 精排全过程"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onPressEnter={() => void runSearch()}
            allowClear
            style={{ flex: 1 }}
          />
          <Tooltip title="最终返回的文档条数(1~50,缺省 8;每路候选取 3 倍)">
            <span>topK <InputNumber min={1} max={50} value={topK} onChange={v => setTopK(v)} style={{ width: 72 }} /></span>
          </Tooltip>
          <Tooltip title="每次执行会真实调用一次查询向量化与 rerank(硅基流动)">
            <Button
              type="primary"
              icon={<SearchOutlined />}
              loading={searching}
              onClick={() => void runSearch()}
            >
              执行检索
            </Button>
          </Tooltip>
        </div>

        <div className="kb-debug-flow">
          <Spin spinning={searching}>
            <div className="kb-debug-flow-inner" style={{ minWidth: 2000 }}>
              {!selectedKb ? (
                <Empty
                  style={{ margin: '80px auto' }}
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="从左侧选择一个知识库开始调试"
                />
              ) : !trace ? (
                <Empty
                  style={{ margin: '80px auto' }}
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    <span>
                      输入查询文本并执行检索,
                      <br />
                      将展示「向量化 → 三路候选 → RRF 融合 → rerank 精排 → topK」全过程
                    </span>
                  }
                />
              ) : (
                <>
                  {/* 查询节点 */}
                  <div className="kb-debug-query-node">
                    <div className="kb-debug-stage-title">查询</div>
                    <div className="kb-debug-query-card">{trace.query}</div>
                    <div className="kb-debug-query-caption">
                      embedding · Qwen3-Embedding-4B · 2560 维
                    </div>
                  </div>
                  <div className="kb-debug-connector" />

                  {/* 三路泳道(向量路为两阶段:候选块 → 同文档聚合,与词法两路的文档级对齐) */}
                  <div className="kb-debug-lanes">
                    <div className="kb-debug-stage-title">三路召回(每路返回 ≤ {trace.candidateLimit} 候选)</div>
                    {trace.paths.map((path, laneIdx) => {
                      const meta = PATH_META[path.path]
                      const isVector = path.path === 'vector'
                      return (
                        <div key={path.path} className="kb-debug-lane" style={{ animationDelay: `${laneIdx * 70}ms` }}>
                          <div className="kb-debug-lane-head">
                            <span className="kb-debug-lane-dot" style={{ background: meta.color }} />
                            <span className="kb-debug-lane-name" style={{ color: meta.color }}>{meta.label}</span>
                            <span className="kb-debug-lane-count">
                              {isVector
                                ? `${path.candidates.length} 块 → ${vectorAgg.length} 文档`
                                : `${path.candidates.length} 候选`}
                            </span>
                          </div>
                          <div className="kb-debug-lane-metric">原始分:{path.metric}</div>
                          <div className={`kb-debug-lane-body${isVector ? ' tall' : ''}`}>
                            {isVector ? (
                              path.candidates.length === 0 ? (
                                <div className="kb-debug-lane-empty">无命中</div>
                              ) : (
                                <>
                                  <div className="kb-debug-stage-label">① 候选块(chunk 级,按余弦距离)</div>
                                  {path.candidates.map(c => (
                                    <button
                                      key={`${c.docId}-${c.chunkIndex ?? 'doc'}-${c.rank}`}
                                      className="kb-debug-chip"
                                      style={{ borderLeftColor: meta.color }}
                                      onClick={() => setDetail({ kind: 'candidate', path, candidate: c })}
                                    >
                                      <span className="kb-debug-chip-rank" style={{ color: meta.color }}>#{c.rank}</span>
                                      <span className="kb-debug-chip-name" title={c.docName}>
                                        {c.docName}
                                        {c.chunkIndex !== null && (
                                          <Typography.Text type="secondary" style={{ fontSize: 11 }}> · 块{c.chunkIndex}</Typography.Text>
                                        )}
                                      </span>
                                      <span className="kb-debug-chip-score">{c.rawScore === null ? '—' : fmt(c.rawScore)}</span>
                                    </button>
                                  ))}
                                  <div className="kb-debug-merge-note">
                                    ↓ 同文档块合并:文档分 = Σ 1/(60 + 块名次),snippet 取名次最优块
                                  </div>
                                  <div className="kb-debug-stage-label">② 文档级候选(按聚合分排序,进入 RRF)</div>
                                  {vectorAgg.map((agg, i) => (
                                    <div
                                      key={agg.docId}
                                      className="kb-debug-agg-row"
                                      style={{ borderLeftColor: meta.color }}
                                      onClick={() => {
                                        const doc = trace.docs.find(d => d.docId === agg.docId)
                                        if (doc) setDetail({ kind: 'vector-agg', doc })
                                      }}
                                    >
                                      <span className="kb-debug-chip-rank" style={{ color: meta.color }}>#{i + 1}</span>
                                      <span className="kb-debug-chip-name" title={agg.docName}>{agg.docName}</span>
                                      <span className="kb-debug-agg-blocks">{agg.blocks} 块</span>
                                      <span className="kb-debug-chip-score">{fmt(agg.agg, 5)}</span>
                                    </div>
                                  ))}
                                </>
                              )
                            ) : path.candidates.length === 0 ? (
                              <div className="kb-debug-lane-empty">无命中</div>
                            ) : (
                              path.candidates.map(c => (
                                <button
                                  key={`${c.docId}-${c.chunkIndex ?? 'doc'}-${c.rank}`}
                                  className="kb-debug-chip"
                                  style={{ borderLeftColor: meta.color }}
                                  onClick={() => setDetail({ kind: 'candidate', path, candidate: c })}
                                >
                                  <span className="kb-debug-chip-rank" style={{ color: meta.color }}>#{c.rank}</span>
                                  <span className="kb-debug-chip-name" title={c.docName}>{c.docName}</span>
                                  <span className="kb-debug-chip-score">{c.rawScore === null ? '—' : fmt(c.rawScore)}</span>
                                </button>
                              ))
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <div className="kb-debug-connector" />

                  {/* RRF 融合 */}
                  <div className="kb-debug-rrf">
                    <div className="kb-debug-stage-title">融合</div>
                    <div className="kb-debug-rrf-card">
                      <div className="kb-debug-rrf-title">RRF 融合</div>
                      <div className="kb-debug-rrf-formula">score = Σ 1/(60 + rank)</div>
                      <div className="kb-debug-rrf-note">
                        按名次换算分数,同文档跨路、跨块累加;取并集,按总分降序取前 {trace.topK * 2} 进入重排。
                      </div>
                    </div>
                  </div>
                  <div className="kb-debug-connector" />

                  {/* 融合结果泳道:RRF 融合后的候选池(2×topK),也是 rerank 的输入 */}
                  <RrfLane
                    trace={trace}
                    onOpenDoc={(doc, index) => setDetail({ kind: 'rrf', doc, index })}
                  />
                  <div className="kb-debug-connector" />

                  {/* rerank 精排泳道 */}
                  {trace.rerankPool.length > 0 && (
                    <>
                      <RerankLane
                        trace={trace}
                        onOpenRow={(row, index) => setDetail({ kind: 'rerank', row, index })}
                      />
                      <div className="kb-debug-connector" />
                    </>
                  )}

                  {/* 结果列表 */}
                  <div className="kb-debug-results">
                    <div className="kb-debug-stage-title">
                      最终结果(kb_search 返回 topK={trace.topK}
                      {rerankActive && ' · 按 rerank 分排序'}
                      )
                      <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: 'none', marginLeft: 10 }}>
                        {(['vector', 'keyword', 'fts'] as const).map(p => (
                          <span key={p} style={{ marginRight: 10 }}>
                            <span
                              className="kb-debug-lane-dot"
                              style={{ background: PATH_META[p].color, display: 'inline-block', marginRight: 4 }}
                            />
                            {PATH_META[p].label}贡献
                          </span>
                        ))}
                      </span>
                    </div>
                    <div className="kb-debug-result-list">
                      {trace.results.length === 0 && (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description={trace.rerankPool.length > 0 ? 'rerank 过滤后无相关文档(候选全部低于阈值)' : '三路均无命中'}
                          style={{ marginTop: 48 }}
                        />
                      )}
                      {trace.results.map((hit, i) => {
                        const doc = trace.docs.find(d => d.docId === hit.docId) ?? null
                        return (
                          <ResultRow
                            key={hit.docId}
                            hit={hit}
                            doc={doc}
                            index={i}
                            maxScore={maxDocScore}
                            rerankMode={rerankActive}
                            onOpen={() => setDetail({ kind: 'final', hit, doc, index: i })}
                          />
                        )
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          </Spin>
        </div>
      </div>

      <Drawer
        title={detailTitle}
        width={460}
        open={detail !== null}
        onClose={() => setDetail(null)}
        destroyOnHidden
      >
        {detail?.kind === 'candidate' && (
          <CandidateDetail path={detail.path} candidate={detail.candidate} />
        )}
        {detail?.kind === 'vector-agg' && trace && (
          <VectorAggDetail doc={detail.doc} trace={trace} />
        )}
        {detail?.kind === 'rrf' && <RrfDetail doc={detail.doc} index={detail.index} />}
        {detail?.kind === 'rerank' && trace && (
          <RerankDetail row={detail.row} index={detail.index} trace={trace} />
        )}
        {detail?.kind === 'final' && trace && (
          <FinalDetail hit={detail.hit} doc={detail.doc} index={detail.index} trace={trace} />
        )}
      </Drawer>
    </div>
  )
}

/**
 * 融合结果泳道:RRF 融合后的候选池(2×topK,按总分降序),即 rerank 阶段的输入。
 * 与三路泳道同款白底泳道样式;点击行打开 RRF 融合明细(总分构成)抽屉。
 */
function RrfLane({ trace, onOpenDoc }: {
  trace: KbSearchTraceDto
  onOpenDoc: (doc: KbTraceDoc, index: number) => void
}) {
  return (
    <div className="kb-debug-stage">
      <div className="kb-debug-stage-title">融合结果(rerank 输入)</div>
      <div className="kb-debug-lane">
        <div className="kb-debug-lane-head">
          <span className="kb-debug-lane-dot" style={{ background: '#4d5cf5' }} />
          <span className="kb-debug-lane-name" style={{ color: '#4d5cf5' }}>RRF 候选池</span>
          <span className="kb-debug-lane-count">{trace.rerankPool.length} 文档</span>
        </div>
        <div className="kb-debug-lane-metric">排序分:RRF 总分(同文档跨路、跨块累加)</div>
        <div className="kb-debug-lane-body tall">
          {trace.rerankPool.length === 0 ? (
            <div className="kb-debug-lane-empty">三路均无命中,候选池为空</div>
          ) : (
            trace.rerankPool.map((row, i) => (
              <button
                key={row.docId}
                className="kb-debug-chip"
                style={{ borderLeftColor: '#4d5cf5', animationDelay: `${Math.min(i, 12) * 45}ms` }}
                onClick={() => {
                  const doc = trace.docs.find(d => d.docId === row.docId)
                  if (doc) onOpenDoc(doc, i)
                }}
              >
                <span className="kb-debug-chip-rank" style={{ color: '#4d5cf5' }}>#{i + 1}</span>
                <span className="kb-debug-chip-name" title={row.docName}>{row.docName}</span>
                <span className="kb-debug-chip-score">{fmt(row.rrfScore, 5)}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * rerank 精排泳道:RRF 候选池(2×topK)逐行展示「RRF 分 → 重排分」,
 * 低于阈值的行置灰,进入最终 topK 的行高亮;点击行打开 rerank 精排明细抽屉。
 */
function RerankLane({ trace, onOpenRow }: {
  trace: KbSearchTraceDto
  onOpenRow: (row: KbTraceRerank, index: number) => void
}) {
  // 全部为 null = 本次 rerank 调用失败降级
  const degraded = trace.rerankPool.every(r => r.rerankScore === null)
  const maxRerank = trace.rerankPool.reduce((max, r) => Math.max(max, r.rerankScore ?? 0), 0)
  return (
    <div className="kb-debug-stage">
      <div className="kb-debug-stage-title">
        重排(rerank · 评审 2×topK={trace.topK * 2} 候选)
        {degraded && (
          <Tag color="warning" style={{ marginLeft: 10, fontWeight: 400 }}>
            本次调用失败降级
          </Tag>
        )}
      </div>
      <div className="kb-debug-lane">
        <div className="kb-debug-lane-head">
          <span className="kb-debug-lane-dot" style={{ background: '#7c3aed' }} />
          <span className="kb-debug-lane-name" style={{ color: '#7c3aed' }}>
            {degraded ? '降级(按 RRF 序)' : 'cross-encoder 精排'}
          </span>
          <span className="kb-debug-lane-count">{trace.rerankPool.length} 候选</span>
        </div>
        <div className="kb-debug-lane-metric">
          {degraded
            ? `rerank 失败,候选池按 RRF 序直接取前 ${trace.topK}`
            : `${trace.rerankModel};低于阈值 ${trace.rerankMinScore} 过滤,过阈值按分数降序取前 ${trace.topK}`}
        </div>
        <div className="kb-debug-lane-body tall">
          {trace.rerankPool.map((row, i) => (
            <RerankRow
              key={row.docId}
              row={row}
              index={i}
              minScore={trace.rerankMinScore}
              maxRerank={maxRerank}
              onOpen={() => onOpenRow(row, i)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** rerank 泳道单行:#池序 + 文档名 + RRF 分 → 重排分条 + 状态标记。 */
function RerankRow({ row, index, minScore, maxRerank, onOpen }: {
  row: KbTraceRerank
  index: number
  minScore: number
  maxRerank: number
  onOpen: () => void
}) {
  const filtered = row.rerankScore !== null && row.rerankScore < minScore
  return (
    <div
      className={`kb-debug-rerank-row${filtered ? ' filtered' : ''}${row.inTopK ? ' selected' : ''}`}
      style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}
      onClick={onOpen}
    >
      <span className="kb-debug-chip-rank" style={{ color: '#7c3aed' }}>#{index + 1}</span>
      <span className="kb-debug-chip-name" title={row.docName}>{row.docName}</span>
      <span className="kb-debug-rerank-rrf">RRF {fmt(row.rrfScore, 5)}</span>
      <span className="kb-debug-rerank-arrow">→</span>
      <div className="kb-debug-rerank-bar-track">
        <div
          className="kb-debug-rerank-bar"
          style={{ width: `${maxRerank > 0 ? ((row.rerankScore ?? 0) / maxRerank) * 100 : 0}%` }}
        />
      </div>
      <span className="kb-debug-rerank-score">{row.rerankScore === null ? '—' : fmt(row.rerankScore)}</span>
      {filtered ? (
        <Tag color="default" style={{ marginInlineEnd: 0 }}>低于阈值</Tag>
      ) : row.inTopK ? (
        <Tag color="success" style={{ marginInlineEnd: 0 }}>入选</Tag>
      ) : (
        <Tag color="default" style={{ marginInlineEnd: 0 }}>备选</Tag>
      )}
    </div>
  )
}

/**
 * 结果行:名次 + 文档名 + RRF 贡献堆叠条(宽度 ∝ 总分,每段 ∝ 单路贡献)+ 分数。
 * rerank 模式下分数为重排分(0~1),否则为 RRF 融合分。
 */
function ResultRow({ hit, doc, index, maxScore, rerankMode, onOpen }: {
  hit: KbSearchHitDto
  doc: KbTraceDoc | null
  index: number
  maxScore: number
  rerankMode: boolean
  onOpen: () => void
}) {
  return (
    <div
      className="kb-debug-result-row"
      style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}
      onClick={onOpen}
    >
      <div className="kb-debug-result-rank">{index + 1}</div>
      <div className="kb-debug-result-main">
        <div className="kb-debug-result-name" title={hit.docName}>{hit.docName}</div>
        {doc && (
          <div className="kb-debug-contrib-bar">
            <div style={{ display: 'flex', width: `${maxScore > 0 ? (doc.totalScore / maxScore) * 100 : 0}%`, height: '100%' }}>
              {doc.contributions.map((c, i) => (
                <div
                  key={i}
                  className="kb-debug-contrib-seg"
                  style={{ width: `${(c.score / doc.totalScore) * 100}%`, background: PATH_META[c.path].color }}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="kb-debug-result-score" title={rerankMode ? 'rerank 重排分(0~1)' : 'RRF 融合分'}>
        {rerankMode ? fmt(hit.score) : fmt(hit.score, 5)}
      </div>
    </div>
  )
}

/** 单路候选明细抽屉。 */
function CandidateDetail({ path, candidate }: { path: KbTracePath; candidate: KbTraceCandidate }) {
  const meta = PATH_META[path.path]
  const isVector = candidate.chunkIndex !== null
  return (
    <>
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">所在路径</div>
        <div className="kb-debug-drawer-value">
          <Tag color={meta.color} style={{ color: '#fff' }}>{meta.label}</Tag>
        </div>
      </div>
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">文档</div>
        <div className="kb-debug-drawer-value">{candidate.docName}</div>
        <div className="kb-debug-drawer-value kb-debug-drawer-mono" style={{ fontSize: 11, color: '#8b90a7' }}>
          docId: {candidate.docId}
        </div>
      </div>
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">路内名次(rank,从 1 起)</div>
        <div className="kb-debug-drawer-value kb-debug-drawer-mono">#{candidate.rank}</div>
      </div>
      {isVector && (
        <div className="kb-debug-drawer-block">
          <div className="kb-debug-drawer-label">块下标(chunk_index)</div>
          <div className="kb-debug-drawer-value kb-debug-drawer-mono">{candidate.chunkIndex}</div>
        </div>
      )}
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">原始排序分({path.metric})</div>
        <div className="kb-debug-drawer-value kb-debug-drawer-mono">
          {candidate.rawScore === null ? '—' : fmt(candidate.rawScore)}
        </div>
      </div>
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">RRF 贡献(该行向文档总分累加的分数)</div>
        <div className="kb-debug-drawer-value kb-debug-drawer-mono">
          1/(60 + {candidate.rank}) = {fmt(candidate.rrfScore, 5)}
        </div>
      </div>
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">命中文本({isVector ? '向量块原文' : '文档前 1000 字符'})</div>
        <div className="kb-debug-snippet">{candidate.snippet || '(空)'}</div>
      </div>
    </>
  )
}

/** 抽屉通用文档头:文档名 + docId。 */
function DocHeader({ docName, docId }: { docName: string; docId: string }) {
  return (
    <div className="kb-debug-drawer-block">
      <div className="kb-debug-drawer-label">文档</div>
      <div className="kb-debug-drawer-value">{docName}</div>
      <div className="kb-debug-drawer-value kb-debug-drawer-mono" style={{ fontSize: 11, color: '#8b90a7' }}>
        docId: {docId}
      </div>
    </div>
  )
}

/**
 * 向量路聚合明细抽屉(点向量路泳道的文档级候选行):只展示向量路本阶段信息——
 * chunk 级聚合分与逐块贡献,不含跨路融合与 rerank/最终结果信息。
 */
function VectorAggDetail({ doc, trace }: { doc: KbTraceDoc; trace: KbSearchTraceDto }) {
  const vectorContribs = doc.contributions.filter(c => c.path === 'vector')
  const vectorSum = vectorContribs.reduce((s, c) => s + c.score, 0)
  // 向量路 chunk 行按名次索引,补充块下标展示
  const chunkIndexByRank = new Map(
    (trace.paths.find(p => p.path === 'vector')?.candidates ?? []).map(c => [c.rank, c.chunkIndex]),
  )
  // 名次最优块 = 该文档在向量路名次最小的块(聚合候选 snippet 的来源)
  const bestChunk = (trace.paths.find(p => p.path === 'vector')?.candidates ?? [])
    .filter(c => c.docId === doc.docId)
    .sort((a, b) => a.rank - b.rank)[0] ?? null
  return (
    <>
      <DocHeader docName={doc.docName} docId={doc.docId} />
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">向量路聚合分(仅 chunk 级 RRF 汇总,不含其他路)</div>
        <div className="kb-debug-drawer-value kb-debug-drawer-mono" style={{ fontSize: 16, color: PATH_META.vector.color, fontWeight: 700 }}>
          {fmt(vectorSum, 5)}
        </div>
      </div>
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">chunk 级贡献(按名次)</div>
        {vectorContribs.map((c, i) => (
          <div
            key={i}
            className="kb-debug-drawer-value"
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px dashed #eef1fa' }}
          >
            <span className="kb-debug-lane-dot" style={{ background: PATH_META.vector.color }} />
            <span className="kb-debug-drawer-mono" style={{ width: 100, flexShrink: 0 }}>
              第 {c.rank} 名{chunkIndexByRank.get(c.rank) !== null && chunkIndexByRank.get(c.rank) !== undefined
                ? ` · 块${chunkIndexByRank.get(c.rank)}`
                : ''}
            </span>
            <span className="kb-debug-drawer-mono" style={{ color: '#8b90a7' }}>
              1/(60+{c.rank}) = {fmt(c.score, 5)}
            </span>
          </div>
        ))}
      </div>
      {bestChunk && (
        <div className="kb-debug-drawer-block">
          <div className="kb-debug-drawer-label">
            名次最优块文本(#{bestChunk.rank}
            {bestChunk.chunkIndex !== null ? ` · 块${bestChunk.chunkIndex}` : ''},聚合候选 snippet 的来源)
          </div>
          <div className="kb-debug-snippet">{bestChunk.snippet || '(空)'}</div>
        </div>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <ExperimentOutlined /> 该分仅含向量路;关键词路 / 全文路的贡献在后续「融合结果」泳道叠加。
      </Typography.Text>
    </>
  )
}

/**
 * RRF 融合明细抽屉(点融合结果泳道行):只展示融合阶段信息——
 * RRF 总分与跨路贡献构成(向量路聚合为一条),不含 rerank 与最终结果信息。
 */
function RrfDetail({ doc, index }: { doc: KbTraceDoc; index: number }) {
  const vectorContribs = doc.contributions.filter(c => c.path === 'vector')
  const otherContribs = doc.contributions.filter(c => c.path !== 'vector')
  const vectorSum = vectorContribs.reduce((s, c) => s + c.score, 0)
  return (
    <>
      <DocHeader docName={doc.docName} docId={doc.docId} />
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">候选池名次(按 RRF 总分降序)</div>
        <div className="kb-debug-drawer-value kb-debug-drawer-mono">#{index + 1}</div>
      </div>
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">RRF 总分(全部贡献累加)</div>
        <div className="kb-debug-drawer-value kb-debug-drawer-mono" style={{ fontSize: 16, color: '#4d5cf5', fontWeight: 700 }}>
          {fmt(doc.totalScore, 5)}
        </div>
      </div>
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">贡献明细(按路;向量路为文档级聚合)</div>
        {vectorContribs.length > 0 && (
          <div
            className="kb-debug-drawer-value"
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px dashed #eef1fa' }}
          >
            <span className="kb-debug-lane-dot" style={{ background: PATH_META.vector.color }} />
            <span style={{ width: 150, flexShrink: 0 }}>向量路 · 文档级聚合</span>
            <span className="kb-debug-drawer-mono" style={{ color: '#8b90a7' }}>
              {vectorContribs.length} 块 Σ 1/(60+名次) = {fmt(vectorSum, 5)}
            </span>
          </div>
        )}
        {otherContribs.map((c, i) => {
          const meta = PATH_META[c.path]
          return (
            <div
              key={i}
              className="kb-debug-drawer-value"
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px dashed #eef1fa' }}
            >
              <span className="kb-debug-lane-dot" style={{ background: meta.color }} />
              <span style={{ width: 150, flexShrink: 0 }}>{meta.label}</span>
              <span className="kb-debug-drawer-mono" style={{ color: '#8b90a7' }}>
                第 {c.rank} 名 1/(60+{c.rank}) = {fmt(c.score, 5)}
              </span>
            </div>
          )
        })}
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <ExperimentOutlined /> 候选池共取 2×topK 条进入 rerank 精排,重排分与入选状态在「重排」泳道查看。
      </Typography.Text>
    </>
  )
}

/**
 * rerank 精排明细抽屉(点重排泳道行):只展示精排阶段信息——
 * 池内序号、输入 RRF 分 → 输出重排分、阈值判断与入选状态,不含召回与融合细节。
 */
function RerankDetail({ row, index, trace }: {
  row: KbTraceRerank
  index: number
  trace: KbSearchTraceDto
}) {
  const degraded = row.rerankScore === null
  const filtered = !degraded && row.rerankScore < trace.rerankMinScore
  return (
    <>
      <DocHeader docName={row.docName} docId={row.docId} />
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">候选池序号(RRF 序)</div>
        <div className="kb-debug-drawer-value kb-debug-drawer-mono">#{index + 1}</div>
      </div>
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">输入分(RRF 融合分)</div>
        <div className="kb-debug-drawer-value kb-debug-drawer-mono">{fmt(row.rrfScore, 5)}</div>
      </div>
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">输出分(rerank 重排分,0~1 越大越相关)</div>
        {degraded ? (
          <div className="kb-debug-drawer-value" style={{ color: '#8b90a7' }}>
            本次 rerank 调用失败降级,未产生重排分
          </div>
        ) : (
          <div className="kb-debug-drawer-value">
            <span className="kb-debug-drawer-mono" style={{ fontSize: 16, color: '#7c3aed', fontWeight: 700 }}>
              {fmt(row.rerankScore)}
            </span>{' '}
            {filtered && (
              <Tag color="default" style={{ marginInlineEnd: 0 }}>
                低于阈值 {trace.rerankMinScore},被过滤
              </Tag>
            )}
          </div>
        )}
      </div>
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">入选状态</div>
        <div className="kb-debug-drawer-value">
          {degraded ? (
            <Tag color="default" style={{ marginInlineEnd: 0 }}>降级:按 RRF 序{row.inTopK ? `取前 ${trace.topK}(在列)` : '未入列'}</Tag>
          ) : row.inTopK ? (
            <Tag color="success" style={{ marginInlineEnd: 0 }}>进入最终 topK</Tag>
          ) : filtered ? (
            <Tag color="default" style={{ marginInlineEnd: 0 }}>被阈值过滤,不参与排序</Tag>
          ) : (
            <Tag color="default" style={{ marginInlineEnd: 0 }}>过阈值但未排进 topK(备选)</Tag>
          )}
        </div>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <ExperimentOutlined /> rerank 送评文本 = 文档名 + 最终 snippet,与返回给用户的摘录同源。
      </Typography.Text>
    </>
  )
}

/**
 * 最终结果明细抽屉(点结果行):只展示输出阶段信息——
 * 最终名次、最终分(含语义)、召回来源归因与最终 snippet。
 */
function FinalDetail({ hit, doc, index, trace }: {
  hit: KbSearchHitDto
  doc: KbTraceDoc | null
  index: number
  trace: KbSearchTraceDto
}) {
  const rerankMode = trace.rerankPool.some(r => r.rerankScore !== null)
  const vectorContribs = doc?.contributions.filter(c => c.path === 'vector') ?? []
  const otherContribs = doc?.contributions.filter(c => c.path !== 'vector') ?? []
  const vectorSum = vectorContribs.reduce((s, c) => s + c.score, 0)
  return (
    <>
      <DocHeader docName={hit.docName} docId={hit.docId} />
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">最终名次</div>
        <div className="kb-debug-drawer-value kb-debug-drawer-mono">#{index + 1}</div>
      </div>
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">
          最终分({rerankMode ? 'rerank 重排分,0~1 越大越相关' : '本次降级:RRF 融合分'})
        </div>
        <div className="kb-debug-drawer-value">
          <span className="kb-debug-drawer-mono" style={{ fontSize: 16, color: rerankMode ? '#7c3aed' : '#4d5cf5', fontWeight: 700 }}>
            {rerankMode ? fmt(hit.score) : fmt(hit.score, 5)}
          </span>
        </div>
      </div>
      {doc && (
        <div className="kb-debug-drawer-block">
          <div className="kb-debug-drawer-label">召回来源归因(进入候选池的贡献构成)</div>
          {vectorContribs.length > 0 && (
            <div
              className="kb-debug-drawer-value"
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px dashed #eef1fa' }}
            >
              <span className="kb-debug-lane-dot" style={{ background: PATH_META.vector.color }} />
              <span style={{ width: 150, flexShrink: 0 }}>向量路 · 文档级聚合</span>
              <span className="kb-debug-drawer-mono" style={{ color: '#8b90a7' }}>
                {vectorContribs.length} 块 Σ 1/(60+名次) = {fmt(vectorSum, 5)}
              </span>
            </div>
          )}
          {otherContribs.map((c, i) => {
            const meta = PATH_META[c.path]
            return (
              <div
                key={i}
                className="kb-debug-drawer-value"
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px dashed #eef1fa' }}
              >
                <span className="kb-debug-lane-dot" style={{ background: meta.color }} />
                <span style={{ width: 150, flexShrink: 0 }}>{meta.label}</span>
                <span className="kb-debug-drawer-mono" style={{ color: '#8b90a7' }}>
                  第 {c.rank} 名 1/(60+{c.rank}) = {fmt(c.score, 5)}
                </span>
              </div>
            )
          })}
        </div>
      )}
      <div className="kb-debug-drawer-block">
        <div className="kb-debug-drawer-label">最终返回的摘录(kb_search snippet = 文档前 1000 字符 + 名次最优块)</div>
        <div className="kb-debug-snippet">{hit.snippet || '(空)'}</div>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        <ExperimentOutlined /> snippet 是原文摘录:文档 text_content 前 1000 字符在前,该文档有向量命中时追加名次最优块(换行分隔)。
      </Typography.Text>
    </>
  )
}
