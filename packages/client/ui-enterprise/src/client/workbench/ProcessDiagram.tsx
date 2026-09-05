/**
 * 流程进度迷你图:部署版 BPMN DI 坐标 → 只读 SVG,按历史活动状态着色。
 *
 * <p>已完成节点绿色、进行中蓝色(呼吸动画)、未开始灰色;已走过(sequenceFlow
 * 历史存在)的连线高亮。不重建 BPMN 语义 —— 分支/并行/回退按实际执行记录
 * 呈现,不做线性化假设。DI 缺失时调用方退回纯执行记录列表。
 */
import { useMemo } from 'react'
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

/** 流程进度迷你图(见模块文档)。 */
export function ProcessDiagram({ diagram, statuses, currentActivityId }: ProcessDiagramProps) {
  const box = useMemo(() => boundingBox(diagram), [diagram])
  const visibleNodes = useMemo(() => diagram.nodes.filter(node => node.kind !== 'lane'), [diagram])
  const lanes = useMemo(() => diagram.nodes.filter(node => node.kind === 'lane'), [diagram])
  const labelRows = useMemo(
    () => visibleNodes.filter(node => node.kind !== 'lane' && node.name !== ''),
    [visibleNodes],
  )

  if (box === null) return null

  return (
    <div className={css.root}>
      <svg
        className={css.svg}
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
        {visibleNodes.map(node => (
          <NodeShape
            key={node.id}
            node={node}
            visual={statuses.get(node.id) === 'done'
              ? 'done'
              : statuses.get(node.id) === 'active' ? 'active' : 'pending'}
            emphasized={node.id === currentActivityId}
          />
        ))}
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
      <div className={css.legend}>
        <span className={css.legendItem}><span className={`${css.legendDot} ${css.dotDone}`} />已完成</span>
        <span className={css.legendItem}><span className={`${css.legendDot} ${css.dotActive}`} />进行中</span>
        <span className={css.legendItem}><span className={`${css.legendDot} ${css.dotPending}`} />未开始</span>
      </div>
    </div>
  )
}
