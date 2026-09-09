/**
 * 流程进度迷你图:部署版 BPMN DI 坐标 → 只读 SVG,按历史活动状态着色。
 *
 * <p>已完成节点绿色、进行中蓝色(呼吸动画)、未开始灰色;已走过(sequenceFlow
 * 历史存在)的连线高亮。不重建 BPMN 语义 —— 分支/并行/回退按实际执行记录
 * 呈现,不做线性化假设。DI 缺失时调用方退回纯执行记录列表。图右上角有
 * 放大按钮,复杂流程在灯箱里看大图:工具条步进缩放 + Ctrl/⌘+滚轮连续缩放,
 * 画布滚动平移,ESC/关闭还原。
 *
 * <p>当前任务所在节点(强调节点)始终渲染为进行中 —— 任务在办理中是事实,
 * 不依赖历史活动快照(快照可能因取消/时序缺失该节点的未结束记录)。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MiniBpmnDiagram, MiniBpmnNode } from '../bpmn-xml.ts'
import type { ActivityStatus } from './pure.ts'
import css from './ProcessDiagram.module.css'

/** 迷你图入参:渲染模型 + 节点/连线状态表。 */
export type ProcessDiagramProps = {
  diagram: MiniBpmnDiagram
  statuses: ReadonlyMap<string, ActivityStatus>
  /** 需要强调的"当前处理节点"activityId(通常为当前任务的 taskDefinitionKey)。 */
  currentActivityId: string | null
}

type NodeVisual = 'done' | 'active' | 'pending'

const PADDING = 24
const LABEL_OFFSET = 6
const MAX_LABEL = 10

const ZOOM_MIN = 1
const ZOOM_MAX = 4
const ZOOM_STEP = 0.25

function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100))
}

/** 计算整图包围盒(节点 + 连线拐点),含内边距;空图返回 null。 */
function boundingBox(diagram: MiniBpmnDiagram): { minX: number; minY: number; width: number; height: number } | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  const extend = (x: number, y: number): void => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  for (const node of diagram.nodes) {
    extend(node.x, node.y)
    extend(node.x + node.width, node.y + node.height)
  }
  for (const edge of diagram.edges) {
    for (const point of edge.points) extend(point.x, point.y)
  }
  if (!Number.isFinite(minX)) return null
  return {
    minX: minX - PADDING, minY: minY - PADDING,
    width: maxX - minX + PADDING * 2, height: maxY - minY + PADDING * 2,
  }
}

/** 节点显示名:空名按类型给缺省。 */
function nodeLabel(node: MiniBpmnNode): string {
  if (node.name !== '') return node.name
  switch (node.kind) {
    case 'start': return '开始'
    case 'end': return '结束'
    default: return node.id
  }
}

function truncate(text: string): string {
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text
}

/** 一个节点的 SVG 主体(形状按 kind,颜色按状态)。 */
function NodeShape(props: { node: MiniBpmnNode; visual: NodeVisual; emphasized: boolean }) {
  const { node, visual, emphasized } = props
  const cx = node.x + node.width / 2
  const cy = node.y + node.height / 2
  const className = [
    visual === 'done' ? css.shapeDone : visual === 'active' ? css.shapeActive : css.shapePending,
    node.kind === 'lane' ? css.laneShape : '',
    emphasized ? css.shapeCurrent : '',
  ].filter(Boolean).join(' ')

  switch (node.kind) {
    case 'start':
    case 'end':
    case 'event':
      return (
        <circle
          cx={cx} cy={cy} r={Math.max(node.width, node.height) / 2}
          className={className}
          data-bpmn-kind={node.kind}
        />
      )
    case 'gateway':
      return (
        <polygon
          points={`${cx},${node.y} ${node.x + node.width},${cy} ${cx},${node.y + node.height} ${node.x},${cy}`}
          className={className}
        />
      )
    default:
      return (
        <rect
          x={node.x} y={node.y} width={node.width} height={node.height}
          rx={Math.min(10, node.height / 4)}
          className={className}
          data-bpmn-kind={node.kind}
        />
      )
  }
}

/** 放大按钮图标:双角向外箭头(Supabase 展开样式)。 */
function ExpandIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <path
        d="M9.5 6.5l4-4M13.5 6V2.5H10M6.5 9.5l-4 4M2.5 10v3.5H6"
        stroke="currentColor" strokeWidth="1.5" fill="none"
        strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  )
}

/** 流程进度迷你图(见模块文档)。 */
export function ProcessDiagram({ diagram, statuses, currentActivityId }: ProcessDiagramProps) {
  const box = useMemo(() => boundingBox(diagram), [diagram])
  const visibleNodes = useMemo(() => diagram.nodes.filter(node => node.kind !== 'lane'), [diagram])
  const lanes = useMemo(() => diagram.nodes.filter(node => node.kind === 'lane'), [diagram])
  const labelRows = useMemo(
    () => visibleNodes.filter(node => node.kind !== 'lane' && node.name !== ''),
    [visibleNodes],
  )
  const [expanded, setExpanded] = useState(false)
  const [zoom, setZoom] = useState(ZOOM_MIN)
  const canvasRef = useRef<HTMLDivElement | null>(null)

  // Ctrl/⌘+滚轮连续缩放;wheel 默认 passive,须原生非 passive 监听才能
  // preventDefault 掉浏览器页面的捏合缩放。普通滚轮保持画布滚动。
  useEffect(() => {
    if (!expanded) return
    const canvas = canvasRef.current
    if (canvas === null) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom(z => clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => { canvas.removeEventListener('wheel', onWheel) }
  }, [expanded])

  if (box === null) return null

  const openLightbox = (): void => {
    setZoom(ZOOM_MIN)
    setExpanded(true)
  }

  /** 同一棵 SVG 按给定样式类渲染(小图与灯箱大图共用)。 */
  const renderSvg = (className: string) => (
    <svg
      className={className}
      viewBox={`${box.minX} ${box.minY} ${box.width} ${box.height}`}
      role="img"
      aria-label="流程进度图"
    >
      {lanes.map(lane => (
        <rect
          key={lane.id}
          x={lane.x} y={lane.y} width={lane.width} height={lane.height}
          className={css.laneRect}
        />
      ))}
      {lanes.map(lane => lane.name === '' ? null : (
        <text
          key={`${lane.id}-label`}
          x={lane.x + 8} y={lane.y + 16}
          className={css.laneLabel}
        >
          {lane.name}
        </text>
      ))}
      {diagram.edges.map((edge) => {
        const taken = statuses.get(edge.id) === 'done'
        return (
          <polyline
            key={edge.id}
            points={edge.points.map(p => `${p.x},${p.y}`).join(' ')}
            className={taken ? css.edgeTaken : css.edgePending}
          />
        )
      })}
      {visibleNodes.map((node) => {
        const status = statuses.get(node.id)
        const visual: NodeVisual = node.id === currentActivityId
          ? 'active'
          : status === 'done' ? 'done' : status === 'active' ? 'active' : 'pending'
        return (
          <NodeShape
            key={node.id}
            node={node}
            visual={visual}
            emphasized={node.id === currentActivityId}
          />
        )
      })}
      {labelRows.map(node => (
        <text
          key={`${node.id}-label`}
          x={node.x + node.width / 2}
          y={node.y + node.height + 12 + LABEL_OFFSET}
          textAnchor="middle"
          className={statuses.get(node.id) === undefined ? css.labelPending : css.labelReached}
        >
          {truncate(nodeLabel(node))}
        </text>
      ))}
    </svg>
  )

  const legend = (
    <div className={css.legend}>
      <span className={css.legendItem}><span className={`${css.legendDot} ${css.dotDone}`} />已完成</span>
      <span className={css.legendItem}><span className={`${css.legendDot} ${css.dotActive}`} />进行中</span>
      <span className={css.legendItem}><span className={`${css.legendDot} ${css.dotPending}`} />未开始</span>
    </div>
  )

  return (
    <div className={css.root}>
      <div className={css.frame}>
        {renderSvg(css.svg ?? '')}
        <button
          type="button"
          className={css.expandBtn}
          onClick={openLightbox}
          aria-label="放大流程图"
          title="放大查看"
        >
          <ExpandIcon />
        </button>
      </div>
      {legend}
      <Modal
        open={expanded}
        onClose={() => setExpanded(false)}
        title="流程进度"
        closeLabel="还原"
        className={css.lightboxDialog ?? ''}
      >
        <div className={css.lightboxToolbar}>
          <button
            type="button"
            className={css.zoomBtn}
            onClick={() => setZoom(z => clampZoom(z - ZOOM_STEP))}
            disabled={zoom <= ZOOM_MIN}
            aria-label="缩小"
          >
            −
          </button>
          <span className={css.zoomLevel}>{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className={css.zoomBtn}
            onClick={() => setZoom(z => clampZoom(z + ZOOM_STEP))}
            disabled={zoom >= ZOOM_MAX}
            aria-label="放大"
          >
            ＋
          </button>
          <button
            type="button"
            className={css.zoomBtn}
            onClick={() => setZoom(ZOOM_MIN)}
            disabled={zoom === ZOOM_MIN}
          >
            适应宽度
          </button>
          <span className={css.zoomHint}>Ctrl + 滚轮缩放</span>
        </div>
        <div className={css.lightboxCanvas} ref={canvasRef}>
          <div className={css.lightboxScaler} style={{ width: `${zoom * 100}%` }}>
            {renderSvg(css.lightboxSvg ?? '')}
          </div>
        </div>
        {legend}
      </Modal>
    </div>
  )
}
