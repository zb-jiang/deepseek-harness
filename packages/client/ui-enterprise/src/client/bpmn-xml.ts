/**
 * 部署版 BPMN XML → 迷你流程图渲染模型。
 *
 * <p>解析 BPMN 语义元素(节点类型/名称)与 BPMNDiagram 图形信息(形状边界/连线拐点),
 * 命名空间无关(按 localName 匹配),兼容 bpmn-js 设计器与 Flowable 直部署的 XML。
 * 只服务只读进度图:不重建完整 BPMN 语义,不做校验;DI 缺失时返回 null
 * (调用方退回纯执行记录列表展示)。
 */

/** 迷你图节点分类(决定绘制形状)。 */
export type MiniBpmnNodeKind = 'task' | 'gateway' | 'start' | 'end' | 'event' | 'lane'

/** 一个图形节点的渲染数据(DI 坐标,原坐标系)。 */
export type MiniBpmnNode = {
  /** BPMN 元素 id(与历史活动 activityId 对齐)。 */
  id: string
  /** 人读名称(空串时按类型给缺省)。 */
  name: string
  kind: MiniBpmnNodeKind
  x: number
  y: number
  width: number
  height: number
}

/** 一条连线的渲染数据(拐点序列,原坐标系)。 */
export type MiniBpmnEdge = {
  /** sequenceFlow id(与历史活动 activityId 对齐)。 */
  id: string
  points: ReadonlyArray<{ x: number; y: number }>
}

/** 整图渲染模型:原坐标包围盒 + 节点 + 连线。 */
export type MiniBpmnDiagram = {
  nodes: readonly MiniBpmnNode[]
  edges: readonly MiniBpmnEdge[]
}

const TASK_LOCAL_NAMES = new Set([
  'task', 'userTask', 'serviceTask', 'sendTask', 'receiveTask', 'manualTask',
  'scriptTask', 'businessRuleTask', 'callActivity', 'subProcess',
])
const GATEWAY_LOCAL_NAMES = new Set([
  'exclusiveGateway', 'parallelGateway', 'inclusiveGateway', 'eventBasedGateway', 'complexGateway',
])
const EVENT_LOCAL_NAMES = new Set([
  'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent',
])

function nodeKindOf(localName: string): MiniBpmnNodeKind | null {
  if (localName === 'startEvent') return 'start'
  if (localName === 'endEvent') return 'end'
  if (TASK_LOCAL_NAMES.has(localName)) return 'task'
  if (GATEWAY_LOCAL_NAMES.has(localName)) return 'gateway'
  if (EVENT_LOCAL_NAMES.has(localName)) return 'event'
  if (localName === 'lane' || localName === 'participant') return 'lane'
  return null
}

/** 递归收集 localName 匹配的元素(process 可嵌套 subProcess)。 */
function collectByLocalName(root: Element, localName: string, out: Element[]): void {
  for (const child of root.children) {
    if (child.localName === localName) out.push(child)
    collectByLocalName(child, localName, out)
  }
}

/**
 * 解析部署版 BPMN XML 为迷你图模型。
 * @param xml 部署版 BPMN XML 原文(/dsh/history/bpmn-xml 返回)。
 * @returns 渲染模型;无 DI 图形信息(或解析失败)时返回 null。
 */
export function parseMiniBpmn(xml: string): MiniBpmnDiagram | null {
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml')
  } catch {
    return null
  }
  if (doc.querySelector('parsererror') !== null) return null

  const root = doc.documentElement
  if (root === null) return null

  // 语义元素表:id → (kind, name)。lane/participant 只有 DI 没有 process 子元素时也入表。
  const semantics = new Map<string, { kind: MiniBpmnNodeKind; name: string }>()
  const shapes: Element[] = []
  collectByLocalName(root, 'BPMNShape', shapes)
  // participant(池)的语义声明在 collaboration 下,不在 process 里;直接从 DI 侧带 kind。
  for (const element of root.getElementsByTagName('*')) {
    const kind = nodeKindOf(element.localName)
    if (kind === null || kind === 'lane') continue
    const id = element.getAttribute('id')
    if (id === null || id === '') continue
    semantics.set(id, { kind, name: element.getAttribute('name') ?? '' })
  }

  const nodes: MiniBpmnNode[] = []
  for (const shape of shapes) {
    const elementId = shape.getAttribute('bpmnElement')
    const bounds = Array.from(shape.children).find(child => child.localName === 'Bounds')
    if (elementId === null || elementId === '' || bounds === undefined) continue
    const x = Number(bounds.getAttribute('x'))
    const y = Number(bounds.getAttribute('y'))
    const width = Number(bounds.getAttribute('width'))
    const height = Number(bounds.getAttribute('height'))
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) continue
    const semantic = semantics.get(elementId)
    // lane/participant 的语义声明可能不在 process 元素树下,按 DI 归类。
    const kind = semantic?.kind ?? 'lane'
    nodes.push({
      id: elementId,
      name: semantic?.name ?? '',
      kind,
      x, y, width, height,
    })
  }
  if (nodes.length === 0) return null

  const edgeElements: Element[] = []
  collectByLocalName(root, 'BPMNEdge', edgeElements)
  const edges: MiniBpmnEdge[] = []
  for (const edge of edgeElements) {
    const elementId = edge.getAttribute('bpmnElement')
    if (elementId === null || elementId === '') continue
    const points: { x: number; y: number }[] = []
    for (const waypoint of edge.children) {
      if (waypoint.localName !== 'waypoint') continue
      const x = Number(waypoint.getAttribute('x'))
      const y = Number(waypoint.getAttribute('y'))
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y })
    }
    if (points.length >= 2) edges.push({ id: elementId, points })
  }

  return { nodes, edges }
}
