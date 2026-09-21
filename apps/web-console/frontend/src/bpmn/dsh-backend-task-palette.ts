/**
 * DSH backend task 画布入口:palette 追加创建条目 + 替换后清理残留标记。
 *
 * <p>DSH backend task 是带 {@code dsh:backendTask} 扩展的 bpmn:ServiceTask
 * (design 2026-09-14 §3):palette 条目创建时一次性写入固定绑定——
 * {@code flowable:delegateExpression="${dshBackendTaskDelegate}"}、
 * {@code flowable:async="true"}、{@code flowable:failedJobRetryTimeCycle=R3/PT1M}
 * (均长任务语义,async job 重试)、{@code dsh:backendTask}(backendProfileUrl 置空,
 * 发布校验拦截空值)。元素属性随创建命令整体入撤销栈。
 *
 * <p>替换清理(§3.2):DSH backend task 经扳手菜单替换为其他类型(user task 等)时,
 * bpmn-js 会把旧元素的 extensionElements 拷到新元素;{@code dsh:BackendTask} 标记
 * 在非 serviceTask 上完全无意义且会让发布校验误收(校验只扫 serviceTask,残留属于
 * 脏数据),故替换后新元素非 serviceTask 时移除该标记。其余 dsh 扩展
 * (userPrompt/skillRef/outputMappings)与 user task 替换的既有策略一致,保留——
 * 校验与引擎对两类节点语义相同,残留等价于配置随替换转移。
 */
import type { BpmnElement, BpmnModdleElement, Injector, ModelingService } from './DshPropertiesProvider'

/** palette 追加条目 id(与内置 create.* 命名一致)。 */
const PALETTE_ENTRY_ID = 'create.dsh-backend-task'

/** 引擎 delegate bean 名(与设计 §6.3、后端校验常量对齐)。 */
export const DSH_BACKEND_DELEGATE_EXPRESSION = '${dshBackendTaskDelegate}'

/** 默认失败重试周期(3 次、间隔 1 分钟)。 */
export const DSH_BACKEND_DEFAULT_RETRY_CYCLE = 'R3/PT1M'

/** bpmn-js DI:元素工厂(shape 创建)。 */
interface ElementFactoryService {
  createShape: (attrs: { type: string; businessObject?: unknown }) => BpmnElement
}

/** bpmn-js DI:businessObject 工厂(moddle 包装)。 */
interface BpmnFactoryService {
  create: (type: string, attrs?: Record<string, unknown>) => BpmnModdleElement
}

/** bpmn-js DI:画布放置(create.start 启动拖放)。 */
interface CreateService {
  start: (event: unknown, shape: unknown, hints?: unknown) => void
}

/** diagram-js DI:命令栈替换事件上下文。 */
interface ReplaceEventContext {
  newShape: BpmnElement
}

/** 事件总线(监听 shape.replace.postExecute)。 */
interface EventBusService {
  on: (event: string, handler: (e: { context: ReplaceEventContext }) => void) => void
}

/**
 * 创建带完整初始属性的 DSH backend task businessObject。
 *
 * <p>导出供替换入口测试与将来的 context pad 复用;属性集合与发布校验
 * {@code validateBackendTasks} 的强校验项一一对应。
 */
export function createBackendTaskBusinessObject(
  bpmnFactory: BpmnFactoryService,
): BpmnModdleElement {
  const backendTask = bpmnFactory.create('dsh:BackendTask', { backendProfileUrl: '' })
  const retry = bpmnFactory.create('flowable:FailedJobRetryTimeCycle', {
    text: DSH_BACKEND_DEFAULT_RETRY_CYCLE,
  })
  const ext = bpmnFactory.create('bpmn:ExtensionElements', { values: [backendTask, retry] })
  return bpmnFactory.create('bpmn:ServiceTask', {
    delegateExpression: DSH_BACKEND_DELEGATE_EXPRESSION,
    async: true,
    extensionElements: ext,
  })
}

/** palette 点击/拖放起点:构造带初始属性的 ServiceTask shape 并启动放置。 */
function startCreateBackendTask(
  event: unknown,
  elementFactory: ElementFactoryService,
  bpmnFactory: BpmnFactoryService,
  create: CreateService,
): void {
  const shape = elementFactory.createShape({
    type: 'bpmn:ServiceTask',
    businessObject: createBackendTaskBusinessObject(bpmnFactory),
  })
  create.start(event, shape)
}

/**
 * palette provider:低优先级(900,晚于内置 1000)updater 往累积 entries
 * 追加 DSH backend task 条目;独立 group 便于与内置任务区分。
 * DI 服务经闭包捕获(getPaletteEntries 挂在实例上,与 DshPropertiesProvider
 * 的 self 模式一致)。
 */
function DshBackendTaskPaletteProvider(
  this: unknown,
  palette: { registerProvider: (priority: number, provider: unknown) => void },
  elementFactory: ElementFactoryService,
  bpmnFactory: BpmnFactoryService,
  create: CreateService,
) {
  const self = this as {
    getPaletteEntries: () => (entries: Record<string, unknown>) => Record<string, unknown>
  }
  self.getPaletteEntries = () => (entries) => {
    entries[PALETTE_ENTRY_ID] = {
      group: 'dsh',
      className: 'bpmn-icon-service',
      title: '创建 DSH 后端任务 (DSH Backend Task):调 backend profile 自动生成 JSON',
      action: {
        click: (event: unknown) => startCreateBackendTask(event, elementFactory, bpmnFactory, create),
        dragstart: (event: unknown) => startCreateBackendTask(event, elementFactory, bpmnFactory, create),
      },
    }
    return entries
  }
  palette.registerProvider(900, self)
}

DshBackendTaskPaletteProvider.$inject = ['palette', 'elementFactory', 'bpmnFactory', 'create']

/**
 * 替换后清理:新元素非 serviceTask 时移除残留的 {@code dsh:BackendTask} 标记
 * (见文件头注释;走 modeling 命令栈,可随替换撤销)。
 */
function DshReplaceCleanupListener(
  this: unknown,
  eventBus: EventBusService,
  injector: Injector,
) {
  const modeling = injector.get<ModelingService>('modeling')
  eventBus.on('commandStack.shape.replace.postExecute', (e) => {
    const newShape = e.context.newShape
    const bo = newShape.businessObject
    if (bo.$type === 'bpmn:ServiceTask') return
    const ext = bo.get('extensionElements') as BpmnModdleElement | undefined
    if (!ext) return
    const values = (ext.get('values') as BpmnModdleElement[]) ?? []
    const next = values.filter(v => v.$type !== 'dsh:BackendTask')
    if (next.length !== values.length) {
      modeling.updateModdleProperties(newShape, ext, { values: next })
    }
  })
}

DshReplaceCleanupListener.$inject = ['eventBus', 'injector']

/** bpmn-js additionalModules 形态的 DI 模块。 */
export const DshBackendTaskPaletteModule = {
  __init__: ['dshBackendTaskPaletteProvider', 'dshReplaceCleanupListener'],
  dshBackendTaskPaletteProvider: ['type', DshBackendTaskPaletteProvider],
  dshReplaceCleanupListener: ['type', DshReplaceCleanupListener],
}
