/**
 * bpmn-js Modeler 的 React 封装。
 *
 * <p>布局为三栏:左侧调色板(拖拽建模)、中间画布、右侧 properties panel(含 DSH 自定义组)。
 * 外部只感知 XML 字符串:{@code xml} prop 外部变化时重新导入;
 * 画布内任何命令栈变更(拖拽/属性编辑)触发 {@code onXmlChange} 回调。
 */
import { useEffect, useRef } from 'react'
import BpmnJS from 'bpmn-js/lib/Modeler'
import {
  BpmnPropertiesPanelModule,
  BpmnPropertiesProviderModule,
} from 'bpmn-js-properties-panel'
import '@bpmn-io/properties-panel/assets/properties-panel.css'
import 'bpmn-js/dist/assets/diagram-js.css'
import 'bpmn-js/dist/assets/bpmn-font/css/bpmn.css'
import { DshPropertiesProviderModule } from './DshPropertiesProvider'
import { DshBackendTaskPaletteModule } from './dsh-backend-task-palette'
import { ReplaceMenuFilterModule } from './replace-menu-filter'
import { dshModdleDescriptor, flowableModdleDescriptor } from './dsh-moddle'

interface BpmnModelerProps {
  /** 当前 BPMN XML(外部 load 或 XML 视图编辑后回灌)。 */
  xml: string
  /** 画布内容变化回调(命令栈变更后 saveXML 的结果)。 */
  onXmlChange: (xml: string) => void
  /** 只读模式(非 draft/disabled 状态):禁用画布与面板交互。 */
  readonly?: boolean
}

interface BpmnModelerInstance {
  importXML: (xml: string) => Promise<unknown>
  saveXML: (opts: { format?: boolean }) => Promise<{ xml: string }>
  on: (event: string, handler: () => void) => void
  destroy: () => void
}

export default function BpmnModeler({ xml, onXmlChange, readonly = false }: BpmnModelerProps) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const paletteRef = useRef<HTMLDivElement>(null)
  const modelerRef = useRef<BpmnModelerInstance | null>(null)
  // 自己 emit 的 xml 存此;xml prop 回流时相同则跳过 importXML,避免导入循环
  const lastEmittedRef = useRef<string>('')
  const onXmlChangeRef = useRef(onXmlChange)
  onXmlChangeRef.current = onXmlChange

  // 初始化 modeler(仅一次)
  useEffect(() => {
    if (!canvasRef.current || !panelRef.current || !paletteRef.current) return
    const modeler = new BpmnJS({
      container: canvasRef.current,
      propertiesPanel: { parent: panelRef.current },
      palette: { parent: paletteRef.current },
      additionalModules: [
        BpmnPropertiesPanelModule,
        BpmnPropertiesProviderModule,
        DshPropertiesProviderModule,
        DshBackendTaskPaletteModule,
        ReplaceMenuFilterModule,
      ],
      moddleExtensions: {
        dsh: dshModdleDescriptor,
        flowable: flowableModdleDescriptor,
      },
    }) as unknown as BpmnModelerInstance
    modelerRef.current = modeler
    modeler.on('commandStack.changed', () => {
      void modeler
        .saveXML({ format: true })
        .then(({ xml: next }) => {
          lastEmittedRef.current = next
          onXmlChangeRef.current(next)
        })
        .catch(() => {
          // saveXML 失败(画布处于中间态)时忽略;下一次命令栈变更会重试
        })
    })
    return () => {
      modeler.destroy()
      modelerRef.current = null
    }
  }, [])

  // xml prop 外部变化(load / XML 视图编辑) → 导入画布
  useEffect(() => {
    const modeler = modelerRef.current
    if (!modeler || !xml) return
    if (xml === lastEmittedRef.current) return
    void modeler.importXML(xml).catch(() => {
      // XML 非法(视图编辑中间态)时保留画布现状;不弹错,由校验按钮统一反馈
    })
  }, [xml])

  return (
    <div
      style={{
        display: 'flex',
        height: 560,
        border: '1px solid #d9d9d9',
        borderRadius: 6,
        background: '#fff',
        overflow: 'hidden',
        // 只读时整体禁用画布与面板交互(保留滚动浏览)
        pointerEvents: readonly ? 'none' : 'auto',
      }}
    >
      {/* 左侧调色板 (Palette) */}
      <div
        ref={paletteRef}
        style={{
          width: 48,
          minHeight: 0,
          borderRight: '1px solid #f0f0f0',
          background: '#fafafa',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '8px 0',
        }}
      />
      {/* 中间画布 */}
      <div ref={canvasRef} style={{ flex: 1, minHeight: 0 }} />
      {/* 右侧属性面板 */}
      <div
        ref={panelRef}
        style={{ width: 340, minHeight: 0, overflowY: 'auto' }}
      />
    </div>
  )
}
