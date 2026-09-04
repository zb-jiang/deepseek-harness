/**
 * bpmn-js NavigatedViewer 的 React 封装(实例历史活动路径图)。
 *
 * <p>只读、可平移缩放;根据历史活动数据高亮执行路径(经典 BPM 审计视图样式):
 * 已完成节点绿色、进行中节点蓝色、已走过的 sequenceFlow 连线绿色加粗。
 * 高亮通过 canvas.addMarker 挂 CSS 类实现,样式见 bpmn-history-viewer.css。
 */
import { useEffect, useRef, useState } from 'react'
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer'
import { Alert, Spin } from 'antd'
import type { HistoricActivityDto } from '../api/process-instances'
import { dshModdleDescriptor, flowableModdleDescriptor } from './dsh-moddle'
import 'bpmn-js/dist/assets/diagram-js.css'
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css'
import './bpmn-history-viewer.css'

interface BpmnHistoryViewerProps {
  /** 实例部署版 BPMN XML。 */
  xml: string
  /** 历史活动列表(驱动高亮;含 sequenceFlow 连线记录)。 */
  activities: HistoricActivityDto[]
}

interface BpmnViewerInstance {
  importXML: (xml: string) => Promise<unknown>
  destroy: () => void
  get: (name: string) => unknown
}

interface CanvasLike {
  addMarker: (elementId: string, marker: string) => void
}

/**
 * 按活动记录给画布元素挂高亮 marker。
 *
 * sequenceFlow 记录给连线挂绿色;其余节点 endTime 有值为已完成(绿),
 * 无值为进行中(蓝)。同一 activityId 出现多条记录(多实例/并行)时
 * 任一条仍在进行即按进行中处理,完成后以绿色覆盖。
 */
function applyHistoryMarkers(viewer: BpmnViewerInstance, activities: HistoricActivityDto[]) {
  const canvas = viewer.get('canvas') as CanvasLike
  const runningIds = new Set<string>()
  for (const act of activities) {
    if (act.activityType === 'sequenceFlow') continue
    if (!act.endTime) runningIds.add(act.activityId)
  }
  for (const act of activities) {
    const marker =
      act.activityType === 'sequenceFlow' || act.endTime
        ? 'dsh-hist-completed'
        : 'dsh-hist-running'
    // 进行中节点不叠加绿色(多实例并行分支:一条完成一条进行 → 蓝)
    if (marker === 'dsh-hist-completed' && runningIds.has(act.activityId)) continue
    try {
      canvas.addMarker(act.activityId, marker)
    } catch {
      // 部署版图上找不到该元素(如并行网关拆分出的内部活动)时跳过
    }
  }
}

export default function BpmnHistoryViewer({ xml, activities }: BpmnHistoryViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<BpmnViewerInstance | null>(null)
  const [importing, setImporting] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 初始化 viewer(仅一次)
  useEffect(() => {
    if (!containerRef.current) return
    const viewer = new NavigatedViewer({
      container: containerRef.current,
      moddleExtensions: {
        dsh: dshModdleDescriptor,
        flowable: flowableModdleDescriptor,
      },
    }) as unknown as BpmnViewerInstance
    viewerRef.current = viewer
    return () => {
      viewer.destroy()
      viewerRef.current = null
    }
  }, [])

  // xml / activities 变化 → 重新导入并高亮
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !xml) return
    let cancelled = false
    setImporting(true)
    setError(null)
    void viewer
      .importXML(xml)
      .then(() => {
        if (cancelled) return
        applyHistoryMarkers(viewer, activities)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'BPMN 图渲染失败')
      })
      .finally(() => {
        if (!cancelled) setImporting(false)
      })
    return () => {
      cancelled = true
    }
  }, [xml, activities])

  return (
    <div
      className="dsh-history-viewer"
      style={{
        position: 'relative',
        height: 480,
        border: '1px solid #d9d9d9',
        borderRadius: 6,
        background: '#fff',
        overflow: 'hidden',
      }}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {importing && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(255,255,255,0.6)' }}>
          <Spin />
        </div>
      )}
      {error && (
        <Alert type="error" showIcon message="BPMN 图渲染失败" description={error} style={{ margin: 8 }} />
      )}
    </div>
  )
}
