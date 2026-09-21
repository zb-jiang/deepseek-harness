/**
 * DSH 自定义 properties panel provider。
 *
 * <p>按元素类型分组渲染:
 * <ul>
 *   <li>{@code bpmn:Process}(流程根) → "DSH 上下文变量"组:
 *       流程级上下文变量声明 CRUD(design 2026-09-01 §4:八种类型、说明、初始值、
 *       启动传入标记、object 字段清单 / array 元素类型)。</li>
 *   <li>{@code bpmn:UserTask}(人工节点) → "DSH 人工节点配置"组:
 *       责任规则(候选角色下拉)、User Prompt 统一弹窗(含变量占位符插入 /
 *       JSON 输出骨架插入 / 默认输出映射 / 实时预览)、skillRefs 多选
 *       (checkbox 列表,选项来自所属应用绑定的 SkillHub 命名空间)、动作策略
 *       (超时升级 + SoD)。单人/会签/串签语义由 BPMN 原生多实例表达
 *       (扳手菜单头部图标设置,不在本面板配置处理策略);多实例组隐藏
 *       loopCardinality 输入框(DSH 派发只认集合形式,计数形式会被发布校验拒绝)。</li>
 *   <li>{@code bpmn:ServiceTask}(自动节点) → 按是否含 {@code dsh:backendTask}
 *       扩展分流:含 → "DSH 后端任务配置"组(backend profile:单实例下拉 /
 *       多实例逐实例列表 + 失败重试 + User Prompt 弹窗 + skillRefs + 会签计票,
 *       delegate/async 固定绑定不可改,design 2026-09-14 §3.3;多实例扩展
 *       2026-09-15);不含 → "Flowable 实现方式"组:delegateExpression /
 *       expression(定制 delegate:代码中 execution.getVariable() 读上下文、
 *       setVariable() 写结果变量) + async 异步开关 + failedJobRetryTimeCycle
 *       失败重试策略;多实例时加挂"多实例(集合)"组(collection 下拉选已声明
 *       array 变量 / elementVariable / 完成条件)与"会签计票"组(三种 task
 *       统一,表决变量=已声明上下文变量)。</li>
 *   <li>{@code bpmn:SequenceFlow}(连线) → "Flowable 条件表达式"组:
 *       conditionExpression 条件表达式(BPMN 原生子元素,排他/包容网关出线路由)。</li>
 *   <li>{@code bpmn:ExclusiveGateway / InclusiveGateway}(排他/包容网关) →
 *       "网关配置"组:默认流 default(BPMN 原生属性,条件全不满足时的兜底出线)。</li>
 *   <li>{@code bpmn:ScriptTask}(脚本任务) → "脚本任务配置"组:
 *       scriptFormat + script(BPMN 原生属性,引擎内执行脚本加工流程变量)。</li>
 *   <li>{@code bpmn:CallActivity}(调用活动) → "调用活动配置"组:
 *       calledElement(BPMN 原生) + inheritVariables / async(flowable: 命名空间)。</li>
 * </ul>
 *
 * <p>设计说明:
 * <ul>
 *   <li>官方 bpmn-js-properties-panel 内置 provider 只提供 General/Documentation/
 *       事件定义(Timer/Message/Signal/Error/Escalation/Link)/多实例等通用组;
 *       任务实现方式等"引擎相关"属性在 CamundaPlatform provider 中绑定 camunda: 命名空间,
 *       对 Flowable 引擎无效,因此 Flowable 属性组由本 provider 提供。</li>
 *   <li>事件组只在事件已带对应定义时出现:选中事件后用画布节点旁的小扳手(context pad)
 *       换成 Timer/Message 等类型,内置属性组即会出现,无需在此重复实现。</li>
 *   <li>删除 routingRule:条件路由走 BPMN 原生 SequenceFlow conditionExpression。</li>
 *   <li>废弃 inputSchema:上游字段直接从 BPMN 流程变量树(context)读取。</li>
 *   <li>废弃 outputSchema / systemPrompt / taskStrategy:输出 JSON 格式直接写在
 *       User Prompt 文本里(骨架按钮按目标上下文变量生成),任务指令只有一段
 *       userPrompt,多实例语义由 BPMN 原生 multiInstanceLoopCharacteristics 表达。</li>
 *   <li>过滤 ReceiveTask 的 Message 组:Flowable 引擎的 ReceiveTask 实现不消费
 *       messageRef,该组对 DSH 用户是误导,因此在属性面板中隐藏。</li>
 *   <li>SendTask 不提供实现方式组且入口已在替换菜单隐藏(replace-menu-filter):
 *       Flowable 只支持 flowable:type(mail/camel/dmn)或 Web Service
 *       operationRef,delegateExpression/expression 会被引擎静默忽略并遭发布
 *       校验拒绝;官方文档的邮件等示例也全部写在 serviceTask 上。粘贴的
 *       sendTask XML 不清理属性,保留原样由引擎发布校验报错(fail loud)。</li>
 *   <li>BusinessRuleTask 不提供实现方式组且入口已在替换菜单隐藏
 *       (replace-menu-filter):Flowable 7 的 BusinessRuleParseHandler 一律
 *       创建 Drools 行为(需 kie-api 依赖),工厂方法只认 class,
 *       flowable:expression/delegateExpression 被完全忽略,缺 kie-api 时部署
 *       直接 NoClassDefFoundError。调 DMN 决策表用 Service Task + 表达式
 *       dmnRuleService(教程第 6.1 节)。粘贴的 businessRuleTask XML 保留
 *       原样,由引擎部署报错(fail loud)。</li>
 * </ul>
 *
 * <p>读写均走 bpmn-js 命令栈({@code modeling.updateModdleProperties} /
 * {@code modeling.updateProperties}),支持撤销重做;XML 序列化契约由
 * {@code dsh-moddle.ts} 保证与引擎 {@code DshBpmnExtensionParser} 对齐。
 */
import { is, isAny } from 'bpmn-js/lib/util/ModelUtil'
import {
  CheckboxEntry,
  CollapsibleEntry,
  ListEntry,
  SelectEntry,
  TextAreaEntry,
  TextFieldEntry,
  isCheckboxEntryEdited,
  isSelectEntryEdited,
  isTextAreaEntryEdited,
  isTextFieldEntryEdited,
  type CheckboxEntryProps,
  type Entry,
  type ListEntryProps,
  type SelectEntryProps,
  type TextAreaEntryProps,
  type TextFieldEntryProps,
} from '@bpmn-io/properties-panel'
import { h, type ComponentChild } from 'preact'
import type { AppRoleDto } from '../api/roles'
import type { BackendProfileDto } from '../api/backend-profiles'
import { userPromptModalEntry } from './UserPromptModal'

/** bpmn-js 图元素的最小结构(provider 只用 businessObject)。 */
export type BpmnElement = { businessObject: BpmnModdleElement }

/** moddle 元素(动态属性访问)。 */
export type BpmnModdleElement = {
  $type: string
  get: (name: string) => unknown
} & Record<string, unknown>

/** DI 服务容器(modeling/moddle 由 injector.get 获取)。 */
export type Injector = { get: <T = unknown>(name: string) => T }

/** modeling 服务:updateModdleProperties 走命令栈可撤销。 */
export interface ModelingService {
  updateProperties: (element: unknown, props: Record<string, unknown>) => void
  updateModdleProperties: (
    element: unknown,
    moddleElement: unknown,
    props: Record<string, unknown>,
  ) => void
}

/** moddle 服务:创建扩展元素实例。 */
export interface ModdleService {
  create: (type: string, props?: Record<string, unknown>) => BpmnModdleElement
}

/**
 * 模块级角色选项容器。
 *
 * <p>provider 由 bpmn-js DI 一次性构造,而角色列表是页面异步数据;
 * 页面加载角色后调 {@link setDshRoleOptions} 注入,entry 渲染时读取。
 */
let currentRoles: AppRoleDto[] = []

export function setDshRoleOptions(roles: AppRoleDto[]): void {
  currentRoles = roles
}

/**
 * 模块级 skill 选项容器。
 *
 * <p>页面加载所属应用后,按其绑定的 SkillHub namespace 拉取已发布 skill
 * 清单并调 {@link setDshSkillOptions} 注入,skillRefs 多选 entry 渲染时读取;
 * 应用未绑定或清单加载失败时为空数组(设计器仍可用)。
 */
let currentSkills: Array<{ value: string; label: string }> = []

export function setDshSkillOptions(skills: Array<{ value: string; label: string }>): void {
  currentSkills = skills
}

/** 读取当前注入的 skill 选项(UserPromptModal 快速插入复用同一份清单)。 */
export function getDshSkillOptions(): Array<{ value: string; label: string }> {
  return currentSkills
}

/**
 * 模块级 backend profile 实例容器。
 *
 * <p>页面加载设计器后调 {@link setDshBackendProfileOptions} 注入 web-console
 * 注册表(心跳 5 分钟内)的活跃实例;DSH backend task 属性面板的 profile 下拉
 * entry 渲染时读取。拉取失败或无实例时为空数组(设计器仍可用,发布校验拦截
 * 空值)。
 */
let currentBackendProfiles: BackendProfileDto[] = []

export function setDshBackendProfileOptions(profiles: BackendProfileDto[]): void {
  currentBackendProfiles = profiles
}

/**
 * 模块级部门树选项容器。
 *
 * <p>页面加载设计器后调 {@link setDshOrgUnitOptions} 注入组织树扁平化清单
 * (value=org_units.id,label=到根路径);userTask 属性面板"指定部门"下拉
 * 渲染时读取。拉取失败或组织未启用时为空数组(发布校验兜底拦截空值)。
 */
let currentOrgUnits: Array<{ value: string; label: string }> = []

export function setDshOrgUnitOptions(units: Array<{ value: string; label: string }>): void {
  currentOrgUnits = units
}

/** SoD 规则类型,引擎 DshExtensionProperties.SodRule 的三个合法值。 */
const SOD_RULE_TYPES = [
  { value: 'not-applicant', label: '审批人不得为申请人 (not-applicant)' },
  { value: 'mutex-node', label: '同实例互斥节点 (mutex-node)' },
  { value: 'countersign-distinct', label: '会签人不重复 (countersign-distinct)' },
] as const

/**
 * 组织维度审批路由(design 2026-09-19 §2.2 组合矩阵):目标角色类型 ×
 * 审批范围。orgScope 缺省(global)=存量全公司行为,XML 不写该属性。
 */
const ASSIGNMENT_TARGET_TYPES = [
  { value: 'entity', label: '实体角色' },
  { value: 'virtual', label: '虚拟角色' },
] as const

/** 审批范围(引擎 DshExtensionProperties.AssignmentRule.orgScope 合法值)。 */
const ORG_SCOPE_OPTIONS = [
  { value: 'global', label: '全公司' },
  { value: 'sameLine', label: '同行政线(申请人所在线,从本人部门向上找)' },
  { value: 'fixedUnit', label: '指定部门' },
] as const

/** 虚拟角色(引擎 virtualRole 合法值;隐含同行政线,范围锁定不可改)。 */
const VIRTUAL_ROLE_OPTIONS = [
  { value: 'parent', label: '上一级负责人(申请人部门的负责人)' },
  { value: 'grandparent', label: '上两级负责人' },
  { value: 'child', label: '下一级扇出(直接子部门负责人)' },
  { value: 'grandchild', label: '下两级扇出' },
] as const

/** 超时升级目标虚拟角色(引擎 escalateToVirtualRole,锚定当前审批人)。 */
const ESCALATE_VIRTUAL_ROLE_OPTIONS = [
  { value: 'parent', label: '上一级负责人(审批人部门的负责人)' },
  { value: 'grandparent', label: '上两级负责人' },
] as const

// ---------------------------------------------------------------------------
// dsh 扩展元素读写辅助
// ---------------------------------------------------------------------------

function getExtensionElements(element: BpmnElement): BpmnModdleElement | undefined {
  const bo = element.businessObject
  const ext = bo.get('extensionElements') as BpmnModdleElement | undefined
  return ext
}

/** 从 extensionElements.values 中按 $type 找 dsh 扩展元素。 */
export function findDshElement(
  element: BpmnElement,
  type: string,
): BpmnModdleElement | undefined {
  const ext = getExtensionElements(element)
  if (!ext) return undefined
  const values = (ext.get('values') as BpmnModdleElement[]) ?? []
  return values.find(v => v.$type === type)
}

/** 确保 extensionElements 存在(不存在则创建,走命令栈);返回它。 */
export function ensureExtensionElements(
  element: BpmnElement,
  injector: Injector,
): BpmnModdleElement {
  const modeling = injector.get<ModelingService>('modeling')
  const moddle = injector.get<ModdleService>('moddle')
  let ext = getExtensionElements(element)
  if (!ext) {
    ext = moddle.create('bpmn:ExtensionElements', { values: [] })
    modeling.updateModdleProperties(element, element.businessObject, {
      extensionElements: ext,
    })
  }
  return ext
}

/** 确保指定 $type 的 dsh 元素存在并应用属性;返回该元素。 */
export function upsertDshElement(
  element: BpmnElement,
  injector: Injector,
  type: string,
  props: Record<string, unknown>,
): BpmnModdleElement {
  const modeling = injector.get<ModelingService>('modeling')
  const moddle = injector.get<ModdleService>('moddle')
  const ext = ensureExtensionElements(element, injector)
  const values = (ext.get('values') as BpmnModdleElement[]) ?? []
  let target = values.find(v => v.$type === type)
  if (!target) {
    target = moddle.create(type, props)
    modeling.updateModdleProperties(element, ext, { values: [...values, target] })
    return target
  }
  modeling.updateModdleProperties(element, target, props)
  return target
}

/** 移除指定 $type 的 dsh 元素(清空字段时调用)。 */
export function removeDshElement(
  element: BpmnElement,
  injector: Injector,
  type: string,
): void {
  const modeling = injector.get<ModelingService>('modeling')
  const ext = getExtensionElements(element)
  if (!ext) return
  const values = (ext.get('values') as BpmnModdleElement[]) ?? []
  const next = values.filter(v => v.$type !== type)
  if (next.length !== values.length) {
    modeling.updateModdleProperties(element, ext, { values: next })
  }
}

/** 文本元素(userPrompt 等)当前值;无元素返回空串。 */
export function getDshText(element: BpmnElement, type: string): string {
  const el = findDshElement(element, type)
  if (!el) return ''
  return (el.get('text') as string) ?? ''
}

// ---------------------------------------------------------------------------
// actionPolicy 嵌套结构读写
// ---------------------------------------------------------------------------

/** 确保 actionPolicy 存在并返回;不存在时创建空容器。 */
function ensureActionPolicy(element: BpmnElement, injector: Injector): BpmnModdleElement {
  const existing = findDshElement(element, 'dsh:ActionPolicy')
  if (existing) return existing
  return upsertDshElement(element, injector, 'dsh:ActionPolicy', {})
}

/** timeoutPolicy 属性读:duration/escalateToRoleId/escalateToUserId/escalateToVirtualRole。 */
function getTimeoutAttr(element: BpmnElement, attr: string): string {
  const policy = findDshElement(element, 'dsh:ActionPolicy')
  if (!policy) return ''
  const timeout = policy.get('timeoutPolicy') as BpmnModdleElement | null
  if (!timeout) return ''
  return (timeout.get(attr) as string) ?? ''
}

/** timeoutPolicy 属性写:无容器逐层创建;全部属性清空时移除 timeoutPolicy。 */
function setTimeoutAttr(
  element: BpmnElement,
  injector: Injector,
  attr: string,
  value: string,
): void {
  const modeling = injector.get<ModelingService>('modeling')
  const moddle = injector.get<ModdleService>('moddle')
  const policy = ensureActionPolicy(element, injector)
  let timeout = policy.get('timeoutPolicy') as BpmnModdleElement | null
  if (!value || !value.trim()) {
    // 只在当前清空的属性是最后一个有效属性时移除整个 timeoutPolicy
    const attrs = ['duration', 'escalateToRoleId', 'escalateToUserId', 'escalateToVirtualRole'].filter(
      a => a !== attr && getTimeoutAttr(element, a),
    )
    if (attrs.length === 0 && timeout) {
      modeling.updateModdleProperties(element, policy, { timeoutPolicy: undefined })
    } else if (timeout) {
      modeling.updateModdleProperties(element, timeout, { [attr]: undefined })
    }
    return
  }
  if (!timeout) {
    timeout = moddle.create('dsh:TimeoutPolicy', { [attr]: value })
    modeling.updateModdleProperties(element, policy, { timeoutPolicy: timeout })
  } else {
    modeling.updateModdleProperties(element, timeout, { [attr]: value })
  }
}

/** SoD:检查指定 type 的 sodRule 是否存在。 */
function hasSodRule(element: BpmnElement, type: string): boolean {
  const policy = findDshElement(element, 'dsh:ActionPolicy')
  if (!policy) return false
  const rules = (policy.get('sodRule') as BpmnModdleElement[]) ?? []
  return rules.some(r => r.get('type') === type)
}

/** SoD:添加或移除指定 type 的 sodRule。 */
function toggleSodRule(
  element: BpmnElement,
  injector: Injector,
  type: string,
  checked: boolean,
): void {
  const modeling = injector.get<ModelingService>('modeling')
  const moddle = injector.get<ModdleService>('moddle')
  const policy = ensureActionPolicy(element, injector)
  const rules = (policy.get('sodRule') as BpmnModdleElement[]) ?? []
  if (checked) {
    if (rules.some(r => r.get('type') === type)) return
    const rule = moddle.create('dsh:SodRule', { type })
    modeling.updateModdleProperties(element, policy, { sodRule: [...rules, rule] })
  } else {
    const next = rules.filter(r => r.get('type') !== type)
    modeling.updateModdleProperties(element, policy, { sodRule: next })
  }
}

// ---------------------------------------------------------------------------
// Process Context:流程级上下文变量声明读写(design 2026-09-01 §4)
// ---------------------------------------------------------------------------

/** 八种上下文变量类型(design 决策 #8)。 */
const VARIABLE_TYPES = [
  { value: 'string', label: 'string (字符串)' },
  { value: 'integer', label: 'integer (整数)' },
  { value: 'float', label: 'float (小数)' },
  { value: 'boolean', label: 'boolean (布尔)' },
  { value: 'date', label: 'date (日期 yyyy-MM-dd)' },
  { value: 'datetime', label: 'datetime (ISO-8601 日期时间)' },
  { value: 'object', label: 'object (对象,挂字段清单)' },
  { value: 'array', label: 'array (数组,声明元素类型)' },
] as const

/** canvas 服务:取流程根元素(其 businessObject 即 bpmn:Process)。 */
interface CanvasService {
  getRootElement: () => { businessObject: BpmnModdleElement }
}

/** 当前画布 process 的 businessObject(上下文声明挂在其 extensionElements)。 */
function getProcessBo(injector: Injector): BpmnModdleElement | undefined {
  const canvas = injector.get<CanvasService>('canvas')
  const root = canvas?.getRootElement()
  return root?.businessObject
}

/** process extensionElements 里的全部 dsh:ContextVariables 容器(正常恰有一个)。 */
function getContextVariablesContainers(
  processBo: BpmnModdleElement,
): BpmnModdleElement[] {
  const ext = processBo.get('extensionElements') as BpmnModdleElement | undefined
  if (!ext) return []
  const values = (ext.get('values') as BpmnModdleElement[]) ?? []
  return values.filter(v => v.$type === 'dsh:ContextVariables')
}

/**
 * 全部容器内的变量声明数组(合并读取)。
 *
 * <p>历史实现版本可能写入多个容器,而引擎与校验器只读第一个;面板按合并结果渲染,
 * 并在选中流程根时触发自愈合并(见 contextVariablesEntries),保证单容器契约。
 */
function getContextVariables(processBo: BpmnModdleElement): BpmnModdleElement[] {
  return getContextVariablesContainers(processBo)
    .flatMap(c => (c.get('contextVariable') as BpmnModdleElement[]) ?? [])
}

/** 从任意选中元素读当前流程的上下文声明(prompt 选择器 / 映射表下拉用)。 */
export function readContextDeclarations(injector: Injector): BpmnModdleElement[] {
  const processBo = getProcessBo(injector)
  return processBo ? getContextVariables(processBo) : []
}

// ---------------------------------------------------------------------------
// Process Context:上下文变量列表的运行时依赖(跨渲染保持稳定)
// ---------------------------------------------------------------------------

/** 上下文变量列表项渲染所需的运行时依赖。 */
interface CtxVarRuntime {
  modeling: ModelingService
  moddle: ModdleService
  injector: Injector
  processBo: BpmnModdleElement
}

/** 按 element 缓存运行时依赖;模块级 component 函数通过它访问 modeling/moddle。 */
const ctxVarRuntimeByElement = new WeakMap<BpmnElement, CtxVarRuntime>()

/** 确保 element 的 dsh:ContextVariables 容器存在。 */
function ensureContextVariablesContainer(element: BpmnElement): BpmnModdleElement | undefined {
  const runtime = ctxVarRuntimeByElement.get(element)
  if (!runtime) return undefined
  const { modeling, moddle } = runtime
  const ext = ensureExtensionElements(element, runtime.injector)
  const values = (ext.get('values') as BpmnModdleElement[]) ?? []
  let container = values.find(v => v.$type === 'dsh:ContextVariables')
  if (!container) {
    container = moddle.create('dsh:ContextVariables', {})
    modeling.updateModdleProperties(element, ext, { values: [...values, container] })
  }
  return container
}

/** 添加一个新的上下文变量。 */
function addContextVariable(element: BpmnElement): void {
  const runtime = ctxVarRuntimeByElement.get(element)
  if (!runtime) return
  const container = ensureContextVariablesContainer(element)
  if (!container) return
  const vars = (container.get('contextVariable') as BpmnModdleElement[]) ?? []
  const variable = runtime.moddle.create('dsh:ContextVariable', { type: 'string' })
  runtime.modeling.updateModdleProperties(element, container, {
    contextVariable: [...vars, variable],
  })
}

/** 删除指定的上下文变量。 */
function removeContextVariable(element: BpmnElement, item: unknown): void {
  const runtime = ctxVarRuntimeByElement.get(element)
  if (!runtime) return
  const { modeling, processBo } = runtime
  const container = getContextVariablesContainers(processBo)
    .find(c => ((c.get('contextVariable') as BpmnModdleElement[]) ?? []).includes(item as BpmnModdleElement))
  if (!container) return
  const vars = (container.get('contextVariable') as BpmnModdleElement[]) ?? []
  modeling.updateModdleProperties(element, container, {
    contextVariable: vars.filter(v => v !== item),
  })
}

/**
 * 来源切换:start-param/空只写 source 属性;选 system 时把声明整写为 initiator
 * 固定结构(object + userId/name/email 三个 string 字段),与启动时注入值和
 * 发布校验器第五查对齐,设计师不必手填结构。
 */
function applySourceSelection(
  runtime: CtxVarRuntime,
  element: BpmnElement,
  variable: BpmnModdleElement,
  source: string,
): void {
  if (source !== 'system') {
    runtime.modeling.updateModdleProperties(element, variable, {
      source: source || undefined,
    })
    return
  }
  const { moddle, modeling } = runtime
  const fields = (['userId', 'name', 'email'] as const).map(fieldName =>
    moddle.create('dsh:Field', { name: fieldName, type: 'string' }))
  modeling.updateModdleProperties(element, variable, {
    source: 'system',
    name: 'initiator',
    type: 'object',
    itemType: undefined,
    initialValue: undefined,
    field: fields,
  })
}

/**
 * 展开 object 字段清单为点路径选项(递归嵌套);array 变量只提供根
 * (元素无静态点路径,JUEL 用 ${list[0]} 索引)。
 */
function expandFieldOptions(
  container: BpmnModdleElement,
  prefix: string,
): Array<{ value: string; label: string }> {
  const fields = (container.get('field') as BpmnModdleElement[]) ?? []
  const out: Array<{ value: string; label: string }> = []
  for (const f of fields) {
    const fname = (f.get('name') as string) ?? ''
    if (!fname.trim()) continue
    const path = `${prefix}.${fname}`
    const ftype = (f.get('type') as string) ?? ''
    out.push({ value: path, label: `${path} (${ftype})` })
    if (ftype === 'object') {
      out.push(...expandFieldOptions(f, path))
    }
  }
  return out
}

/** 生成全部可选点路径(object 递归展开字段;array 只到根)。 */
export function buildContextPaths(injector: Injector): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = []
  for (const v of readContextDeclarations(injector)) {
    const name = (v.get('name') as string) ?? ''
    if (!name.trim()) continue
    const type = (v.get('type') as string) ?? 'string'
    out.push({ value: name, label: `${name} (${type})` })
    if (type === 'object') {
      out.push(...expandFieldOptions(v, name))
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// entry 工厂
// ---------------------------------------------------------------------------

/**
 * v3 entry 包装:@bpmn-io/properties-panel 导出的 *Entry 是组件本体(内部用 hooks),
 * 必须在渲染上下文调用。entries 数组元素须为 {@code { id, component, isEdited }} 对象,
 * component 在 panel 渲染该 entry 时被调用;这里闭包捕获 props 并转调组件。
 *
 * <p>渲染时从 DI 取 {@code debounceInput} 工厂传入 debounced 输入回调
 * (与内置 provider 的 useService('debounceInput') 一致;缺失时文本 entry 抛
 * "debounceFn is not a function")。
 */
function wrapEntry(
  id: string,
  render: (renderProps: Record<string, unknown>) => unknown,
  isEdited?: (node: unknown) => boolean,
): Entry {
  const entry: Entry = { id, component: render }
  if (isEdited) entry.isEdited = isEdited
  return entry
}

/** select entry 包装(候选角色等下拉)。 */
function selectEntry(props: SelectEntryProps, injector: Injector): Entry {
  return wrapEntry(
    props.id,
    p => SelectEntry({ debounce: injector.get('debounceInput'), ...props, ...p }),
    isSelectEntryEdited,
  )
}

/** text field entry 包装(单行文本,如超时时长)。 */
function textFieldEntry(props: TextFieldEntryProps, injector: Injector): Entry {
  return wrapEntry(
    props.id,
    p => TextFieldEntry({ debounce: injector.get('debounceInput'), ...props, ...p }),
    isTextFieldEntryEdited,
  )
}

/** textarea entry 包装(多行文本,如 userPrompt)。 */
function textAreaEntry(props: TextAreaEntryProps, injector: Injector): Entry {
  return wrapEntry(
    props.id,
    p => TextAreaEntry({ debounce: injector.get('debounceInput'), ...props, ...p }),
    isTextAreaEntryEdited,
  )
}

/** checkbox entry 包装(SoD 勾选等)。 */
function checkboxEntry(props: CheckboxEntryProps): Entry {
  return wrapEntry(props.id, p => CheckboxEntry({ ...props, ...p }), isCheckboxEntryEdited)
}

/** list entry 包装(上下文变量 / 输出映射等可增删列表)。 */
function listEntry(props: ListEntryProps): Entry {
  return wrapEntry(props.id, () => ListEntry(props))
}

/**
 * skillRefs 多选 entry:checkbox 列表。
 *
 * <p>properties panel 内部运行 preact(非 React),因此照 userPromptModalEntry
 * 的方式用 {@code h} + 原生事件渲染。选项来自页面注入的应用绑定 SkillHub
 * skill 清单({@link setDshSkillOptions});选中集合 = BPMN 中的
 * {@code dsh:SkillRef} 列表,勾选/取消经 setSkillRefs 走命令栈写回(可撤销)。
 *
 * <p>BPMN 中已有但不在选项列表的 skill 名(textarea 时代遗留 / 换绑后悬空)
 * 渲染为已勾选的额外行并标记「(不在当前命名空间)」,允许取消勾选;
 * 选项为空(应用未绑 namespace 或清单加载失败)时显示提示文本,
 * 遗留值仍显示,便于清理。
 */
function skillRefsEntry(
  getSkillRefs: () => string[],
  setSkillRefs: (names: string[]) => void,
): Entry {
  return {
    id: 'dsh-skillRefs',
    component: () => {
      const selected = getSkillRefs()
      const rows: Array<{ value: string; label: string; dangling: boolean }> =
        currentSkills.map(o => ({ value: o.value, label: o.label, dangling: false }))
      for (const name of selected) {
        if (!rows.some(r => r.value === name)) {
          rows.push({ value: name, label: `${name} (不在当前命名空间)`, dangling: true })
        }
      }
      const toggle = (name: string, checked: boolean) => {
        const current = getSkillRefs()
        setSkillRefs(
          checked
            ? (current.includes(name) ? current : [...current, name])
            : current.filter(s => s !== name),
        )
      }
      const children: ComponentChild[] = [
        h('label', { className: 'bio-properties-panel-label' }, 'Skill 引用'),
        h('div', { className: 'bio-properties-panel-description' },
          '多选;选项来自所属应用绑定的 SkillHub 命名空间'),
      ]
      if (currentSkills.length === 0) {
        children.push(h('div', { className: 'bio-properties-panel-description' },
          '所属应用未配置 SkillHub namespace,请先在应用管理的 Skill 仓库配置'))
      }
      for (const row of rows) {
        children.push(
          h('label', {
            className: 'dsh-skillref-option',
            style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' },
          },
          h('input', {
            type: 'checkbox',
            checked: selected.includes(row.value),
            onClick: (e: Event) => toggle(row.value, (e.target as HTMLInputElement).checked),
          }),
          h('span', { style: row.dangling ? { color: '#d46b08' } : undefined }, row.label),
          ),
        )
      }
      return h('div', null, children)
    },
    isEdited: (node: unknown) =>
      (node as HTMLElement).querySelectorAll('input[type="checkbox"]:checked').length > 0,
  }
}

/** 角色下拉选项(含"未指定"空项);数据来自页面注入的应用角色列表。 */
function roleOptions(): Array<{ value: string; label: string }> {
  return [
    { value: '', label: '(未指定)' },
    ...currentRoles.map(r => ({ value: r.id, label: r.name })),
  ]
}

// ---------------------------------------------------------------------------
// Process Context:「上下文变量」面板(process 级)
// ---------------------------------------------------------------------------

/**
 * 流程根元素的「上下文变量」面板 entries(design 2026-09-01 §4)。
 *
 * <p>ListEntry 增删变量;每个变量 CollapsibleEntry 展开:名称/类型/说明/初始值
 * (按类型出控件)/来源(启动传入 start-param / 系统注入 system / 空)/array 元素类型
 * /object 字段清单。节点产出来源不手选,由发布校验器从输出映射与产出声明自动推导。
 */
/**
 * 上下文变量列表项组件。
 *
 * <p>模块级稳定函数,保证 ListEntry/ItemsList 不因为 component 引用变化而重新挂载,
 * 从而保持 CollapsibleEntry 的展开状态。运行时依赖从 {@link ctxVarRuntimeByElement}
 * 读取;若缓存未命中(理论上不应发生)返回 null。
 */
function ContextVariableListItem(props: {
  element?: unknown
  item: unknown
  index: number
  open: boolean
}): unknown {
  const element = props.element as BpmnElement | undefined
  const runtime = element ? ctxVarRuntimeByElement.get(element) : undefined
  if (!element || !runtime) return null

  const { modeling, injector } = runtime
  const variable = props.item as BpmnModdleElement
  const idx = props.index
  const name = (variable.get('name') as string) ?? ''
  const type = (variable.get('type') as string) ?? 'string'
  const setAttr = (attr: string, value: unknown) =>
    modeling.updateModdleProperties(element, variable, { [attr]: value })

  const entries: Entry[] = [
    textFieldEntry({
      id: `ctx-var-${idx}-name`,
      element,
      label: '名称',
      description: '',
      getValue: () => name,
      setValue: v => setAttr('name', v.trim() || undefined),
    }, injector),
    selectEntry({
      id: `ctx-var-${idx}-type`,
      element,
      label: '类型',
      description: '',
      getOptions: () => [...VARIABLE_TYPES],
      getValue: () => type,
      setValue: v => setAttr('type', v),
    }, injector),
    textFieldEntry({
      id: `ctx-var-${idx}-description`,
      element,
      label: '说明',
      description: '',
      getValue: () => (variable.get('description') as string) ?? '',
      setValue: v => setAttr('description', v.trim() || undefined),
    }, injector),
    ...initialValueEntries(element, injector, variable, idx, type),
    selectEntry({
      id: `ctx-var-${idx}-source`,
      element,
      label: '来源',
      description: '',
      getOptions: () => [
        { value: '', label: '节点产出 / 初始值' },
        { value: 'start-param', label: '启动传入 (start-param)' },
        { value: 'system', label: '系统注入 (initiator)' },
      ],
      getValue: () => (variable.get('source') as string) ?? '',
      setValue: v => applySourceSelection(runtime, element, variable, v),
    }, injector),
  ]

  if (type === 'array') {
    entries.push(
      selectEntry({
        id: `ctx-var-${idx}-itemType`,
        element,
        label: '元素类型 (itemType)',
        description: 'array 元素的类型;为 object 时配置元素字段清单',
        getOptions: () => VARIABLE_TYPES.filter(t => t.value !== 'array'),
        getValue: () => (variable.get('itemType') as string) ?? '',
        setValue: v => setAttr('itemType', v || undefined),
      }, injector),
    )
  }

  // object 字段清单 / array(object 元素)的元素字段清单
  const itemType = (variable.get('itemType') as string) ?? ''
  const wantsFields = type === 'object' || (type === 'array' && itemType === 'object')
  if (wantsFields) {
    entries.push(
      fieldListEntry(element, injector, variable, `ctx-var-${idx}`),
    )
  }

  // 列表项 component 必须返回 JSX(组件本体调用结果),返回 entry 描述对象会渲染成空白项;
  // 删除按钮由列表级 onRemove 提供,项上不传 remove(否则出现两个删除按钮)
  return CollapsibleEntry({
    id: `ctx-var-${idx}`,
    element,
    label: name.trim() ? `${name} (${type})` : `<未命名变量 ${idx + 1}>`,
    entries,
    open: props.open,
  })
}

/**
 * 上下文变量列表 entry 渲染函数。
 *
 * <p>模块级稳定函数,从 props.element 读取当前 element,在渲染时实时读取 items,
 * 因此 ListEntry 不会重新挂载,同时能反映最新数据。
 */
function ContextVariablesList(props: { element?: unknown }): unknown {
  const element = props.element as BpmnElement | undefined
  if (!element) return null
  return ListEntry({
    id: 'dsh-context-variables',
    element,
    label: '上下文变量',
    items: getContextVariables(element.businessObject),
    component: ContextVariableListItem,
    onAdd: () => addContextVariable(element),
    onRemove: item => removeContextVariable(element, item),
    autoFocusEntry: '.bio-properties-panel-input',
  })
}

function contextVariablesEntries(element: BpmnElement, injector: Injector): Entry[] {
  const modeling = injector.get<ModelingService>('modeling')
  const moddle = injector.get<ModdleService>('moddle')
  const processBo = element.businessObject

  // 把运行时依赖注册到 WeakMap,供模块级 component 函数跨渲染复用
  ctxVarRuntimeByElement.set(element, { modeling, moddle, injector, processBo })

  // 数据自愈:历史实现版本可能写入多个 dsh:ContextVariables 容器,而引擎与校验器
  // 只读第一个;发现多容器时把全部变量并入第一个并删除多余容器。
  // 面板正在渲染中,合并放到下一个宏任务执行,完成后面板随 commandStack.changed 重渲染。
  const containers = getContextVariablesContainers(processBo)
  if (containers.length > 1) {
    const [first, ...extras] = containers
    setTimeout(() => {
      const merged = [
        ...((first.get('contextVariable') as BpmnModdleElement[]) ?? []),
        ...extras.flatMap(c => (c.get('contextVariable') as BpmnModdleElement[]) ?? []),
      ]
      modeling.updateModdleProperties(element, first, { contextVariable: merged })
      const ext = processBo.get('extensionElements') as BpmnModdleElement
      modeling.updateModdleProperties(element, ext, {
        values: ((ext.get('values') as BpmnModdleElement[]) ?? []).filter(v => !extras.includes(v)),
      })
    }, 0)
  }

  return [{ id: 'dsh-context-variables', component: ContextVariablesList }]
}

/**
 * object / array(object 元素)初始值与字段清单的一致性校验:
 * JSON 的键必须已在字段清单中声明(嵌套 object 递归检查),
 * 避免初始值游离于结构声明之外。
 */
function initialValueFieldsError(
  value: string,
  variable: BpmnModdleElement,
  type: string,
): string | null {
  if (!value.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return '不是合法的 JSON'
  }
  const fields = (variable.get('field') as BpmnModdleElement[]) ?? []
  if (type === 'object') return objectKeysError(parsed, fields, '')
  if (!Array.isArray(parsed)) return 'array 初始值必须是 JSON 数组文本,如 [1,2]'
  for (let i = 0; i < parsed.length; i++) {
    const err = objectKeysError(parsed[i], fields, `[${i}].`)
    if (err) return err
  }
  return null
}

/** 单个 object 值的键与字段声明一致性(递归);fields 为该 object 层级的字段清单。 */
function objectKeysError(
  value: unknown,
  fields: BpmnModdleElement[],
  path: string,
): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `${path || '初始值'}必须是 JSON 对象文本,如 {"k":"v"}`
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const field = fields.find(f => ((f.get('name') as string) ?? '').trim() === key)
    if (!field) return `键 "${path}${key}" 未在字段清单中声明`
    if (
      ((field.get('type') as string) ?? 'string') === 'object'
      && v !== null && typeof v === 'object' && !Array.isArray(v)
    ) {
      const err = objectKeysError(v, (field.get('field') as BpmnModdleElement[]) ?? [], `${path}${key}.`)
      if (err) return err
    }
  }
  return null
}

/** 初始值 entries:boolean 出下拉,date/datetime 提示格式;其余单行文本;object/array 校验与字段清单一致。 */
function initialValueEntries(
  element: BpmnElement,
  injector: Injector,
  variable: BpmnModdleElement,
  idx: number,
  type: string,
): Entry[] {
  const id = `ctx-var-${idx}-initialValue`
  const get = () => (variable.get('initialValue') as string) ?? ''
  const set = (v: string) =>
    injector.get<ModelingService>('modeling').updateModdleProperties(element, variable, {
      initialValue: v.trim() || undefined,
    })
  if (type === 'boolean') {
    return [
      selectEntry({
        id,
        element,
        label: '初始值',
        description: '可选;启动传入可覆盖',
        getOptions: () => [
          { value: '', label: '(未设置)' },
          { value: 'true', label: 'true' },
          { value: 'false', label: 'false' },
        ],
        getValue: get,
        setValue: set,
      }, injector),
    ]
  }
  const formatHint: Record<string, string> = {
    date: '严格格式 yyyy-MM-dd,如 2026-01-31',
    datetime: '严格格式 ISO-8601,如 2026-01-31T09:30:00',
    integer: '整数,如 100',
    float: '小数,如 99.5',
    object: 'JSON 文本,键须已在字段清单中声明,如 {"k":"v"}',
    array: 'JSON 数组文本,如 [1,2]',
  }
  const wantsFieldCheck =
    type === 'object' || (type === 'array' && (variable.get('itemType') as string) === 'object')
  return [
    textFieldEntry({
      id,
      element,
      label: '初始值',
      description: `可选;启动未传入时兜底。${formatHint[type] ?? ''}`,
      placeholder: type === 'date' ? '2026-01-31' : type === 'datetime' ? '2026-01-31T09:30:00' : undefined,
      getValue: get,
      setValue: set,
      validate: wantsFieldCheck
        ? (v: string) => initialValueFieldsError(v ?? '', variable, type)
        : undefined,
    }, injector),
  ]
}

/**
 * 字段清单 entry(object 变量 / array 的 object 元素),挂 dsh:Field 子元素;
 * Field 类型为 object 时递归挂下一层(点路径多级引用)。
 */
function fieldListEntry(
  element: BpmnElement,
  injector: Injector,
  container: BpmnModdleElement,
  keyPrefix: string,
): Entry {
  const modeling = injector.get<ModelingService>('modeling')
  const moddle = injector.get<ModdleService>('moddle')

  const removeField = (item: unknown) => {
    const fields = (container.get('field') as BpmnModdleElement[]) ?? []
    modeling.updateModdleProperties(element, container, {
      field: fields.filter(f => f !== item),
    })
  }

  const renderField = (props: { index: number; item: unknown; open?: boolean }): unknown => {
    const field = props.item as BpmnModdleElement
    const idx = props.index
    const fname = (field.get('name') as string) ?? ''
    const ftype = (field.get('type') as string) ?? 'string'
    const setAttr = (attr: string, value: unknown) =>
      modeling.updateModdleProperties(element, field, { [attr]: value })

    const entries: Entry[] = [
      textFieldEntry({
        id: `${keyPrefix}-field-${idx}-name`,
        element,
        label: '字段名',
        getValue: () => fname,
        setValue: v => setAttr('name', v.trim() || undefined),
      }, injector),
      selectEntry({
        id: `${keyPrefix}-field-${idx}-type`,
        element,
        label: '类型',
        getOptions: () => [...VARIABLE_TYPES],
        getValue: () => ftype,
        setValue: v => setAttr('type', v),
      }, injector),
      textFieldEntry({
        id: `${keyPrefix}-field-${idx}-description`,
        element,
        label: '说明',
        getValue: () => (field.get('description') as string) ?? '',
        setValue: v => setAttr('description', v.trim() || undefined),
      }, injector),
    ]
    if (ftype === 'object') {
      entries.push(fieldListEntry(element, injector, field, `${keyPrefix}-field-${idx}`))
    }
    return CollapsibleEntry({
      id: `${keyPrefix}-field-${idx}`,
      element,
      label: fname.trim() ? `${fname} (${ftype})` : `<未命名字段 ${idx + 1}>`,
      entries,
      open: props.open,
    })
  }

  return listEntry({
    id: `${keyPrefix}-fields`,
    element,
    label: '字段清单',
    items: (container.get('field') as BpmnModdleElement[]) ?? [],
    component: props => renderField({ index: props.index, item: props.item }),
    onAdd: () => {
      const fields = (container.get('field') as BpmnModdleElement[]) ?? []
      const field = moddle.create('dsh:Field', { type: 'string' })
      modeling.updateModdleProperties(element, container, { field: [...fields, field] })
    },
    onRemove: removeField,
    autoFocusEntry: '.bio-properties-panel-input',
  })
}

/**
 * skillRefs 读写访问器(user task 与 DSH backend task 共用)。
 *
 * <p>读:extensionElements 中全部 {@code dsh:SkillRef} 正文(非空、去空白);
 * 写:整组重建走命令栈(可撤销)。
 */
function skillRefsAccessors(
  element: BpmnElement,
  injector: Injector,
): {
  getSkillRefs: () => string[]
  setSkillRefs: (names: string[]) => void
} {
  return {
    getSkillRefs: () =>
      ((getExtensionElements(element)?.get('values') as BpmnModdleElement[] | undefined) ?? [])
        .filter(v => v.$type === 'dsh:SkillRef')
        .map(v => ((v.get('text') as string) ?? '').trim())
        .filter(Boolean),
    setSkillRefs: (names: string[]) => {
      const modeling = injector.get<ModelingService>('modeling')
      const moddle = injector.get<ModdleService>('moddle')
      const ext = ensureExtensionElements(element, injector)
      const values = (ext.get('values') as BpmnModdleElement[]) ?? []
      const kept = values.filter(v => v.$type !== 'dsh:SkillRef')
      const newRefs = names.map(name => moddle.create('dsh:SkillRef', { text: name }))
      modeling.updateModdleProperties(element, ext, { values: [...kept, ...newRefs] })
    },
  }
}

/** UserTask 的 DSH 配置组 entries。 */
function userTaskDshEntries(element: BpmnElement, injector: Injector): Entry[] {
  const entries: Entry[] = []
  // --- 责任规则(design 2026-09-19 §6.3:目标角色类型 × 审批范围组合矩阵) ---
  // virtualRole 非空 = 虚拟角色(隐含同行政线,orgScope/fixedUnitId 必须为空);
  // 否则实体角色,orgScope 缺省 = 全公司(存量行为,XML 不写属性)
  const assignment = findDshElement(element, 'dsh:AssignmentRule')
  const candidateRoleId = assignment ? ((assignment.get('candidateRoleId') as string) ?? '') : ''
  const virtualRole = assignment ? ((assignment.get('virtualRole') as string) ?? '') : ''
  const orgScope = assignment ? ((assignment.get('orgScope') as string) ?? '') : ''
  const fixedUnitId = assignment ? ((assignment.get('fixedUnitId') as string) ?? '') : ''
  const isVirtual = !!virtualRole

  // 目标角色类型:实体/虚拟切换(切换写法保持互斥,引擎解析按 virtualRole 优先)
  entries.push(
    selectEntry({
      id: 'dsh-assignment-targetType',
      element,
      label: '目标角色类型',
      description: '虚拟角色=按组织行政线取部门负责人;实体角色=按应用内角色成员解析',
      getOptions: () => [...ASSIGNMENT_TARGET_TYPES],
      getValue: () => (isVirtual ? 'virtual' : 'entity'),
      setValue: (value) => {
        if (value === 'virtual') {
          upsertDshElement(element, injector, 'dsh:AssignmentRule', {
            virtualRole: 'parent',
            candidateRoleId: undefined,
            orgScope: undefined,
            fixedUnitId: undefined,
          })
        } else {
          // 切回实体:清掉虚拟角色的同时不再有任何有效属性 → 移除整条规则,
          // 等用户重新选候选角色(发布校验兜底拦截无角色的范围配置)
          removeDshElement(element, injector, 'dsh:AssignmentRule')
        }
      },
    }, injector),
  )

  if (isVirtual) {
    // 虚拟角色:范围锁定同行政线(置灰),只选虚拟角色
    entries.push(
      selectEntry({
        id: 'dsh-assignment-virtualRole',
        element,
        label: '虚拟角色',
        description: '',
        getOptions: () => [{ value: '', label: '(未指定)' }, ...VIRTUAL_ROLE_OPTIONS],
        getValue: () => virtualRole,
        setValue: (value) => {
          if (!value) {
            removeDshElement(element, injector, 'dsh:AssignmentRule')
            return
          }
          upsertDshElement(element, injector, 'dsh:AssignmentRule', { virtualRole: value })
        },
      }, injector),
      selectEntry({
        id: 'dsh-assignment-lockedScope',
        element,
        label: '审批范围',
        description: '虚拟角色沿行政线解析,范围固定为同行政线',
        disabled: true,
        getOptions: () => [{ value: 'sameLine', label: '同行政线' }],
        getValue: () => 'sameLine',
        setValue: () => {},
      }, injector),
    )
  } else {
    // 实体角色:候选角色 + 审批范围(全公司缺省/同行政线/指定部门)
    entries.push(
      selectEntry({
        id: 'dsh-assignment-candidateRole',
        element,
        label: '候选角色',
        description: '',
        getOptions: () => roleOptions(),
        getValue: () => candidateRoleId,
        setValue: (value) => {
          if (!value) {
            removeDshElement(element, injector, 'dsh:AssignmentRule')
            return
          }
          upsertDshElement(element, injector, 'dsh:AssignmentRule', { candidateRoleId: value })
        },
      }, injector),
      selectEntry({
        id: 'dsh-assignment-orgScope',
        element,
        label: '审批范围',
        description: '缺省全公司=存量行为',
        getOptions: () => [...ORG_SCOPE_OPTIONS],
        getValue: () => orgScope || 'global',
        setValue: (value) => {
          if (value === 'global') {
            upsertDshElement(element, injector, 'dsh:AssignmentRule', {
              orgScope: undefined,
              fixedUnitId: undefined,
            })
          } else if (value === 'sameLine') {
            upsertDshElement(element, injector, 'dsh:AssignmentRule', {
              orgScope: 'sameLine',
              fixedUnitId: undefined,
            })
          } else {
            upsertDshElement(element, injector, 'dsh:AssignmentRule', {
              orgScope: 'fixedUnit',
            })
          }
        },
      }, injector),
    )
    if (orgScope === 'fixedUnit') {
      entries.push(
        selectEntry({
          id: 'dsh-assignment-fixedUnit',
          element,
          label: '指定部门',
          description: '该部门及其子树内的候选角色成员收到待办',
          getOptions: () => [{ value: '', label: '(未指定,发布校验会拦截)' }, ...currentOrgUnits],
          getValue: () => fixedUnitId,
          setValue: (value) => {
            upsertDshElement(element, injector, 'dsh:AssignmentRule', {
              fixedUnitId: value || undefined,
            })
          },
        }, injector),
      )
    }
  }

  // --- User Prompt:统一弹窗内编辑(含变量插入 / JSON 骨架 / 输出映射 / 预览) ---
  entries.push(userPromptModalEntry(element, injector))

  // --- skillRefs:多选 checkbox 列表;选项来自所属应用绑定的 SkillHub 命名空间 ---
  const { getSkillRefs, setSkillRefs } = skillRefsAccessors(element, injector)
  entries.push(skillRefsEntry(getSkillRefs, setSkillRefs))

  // --- 超时升级策略(目标优先级:虚拟角色 > 用户 > 实体角色,引擎对齐) ---
  entries.push(
    textFieldEntry({
      id: 'dsh-timeout-duration',
      element,
      label: '超时时长',
      description: 'ISO-8601 时长,如 PT24H;留空表示不超时',
      getValue: () => getTimeoutAttr(element, 'duration'),
      setValue: value => setTimeoutAttr(element, injector, 'duration', value),
    }, injector),
    selectEntry({
      id: 'dsh-timeout-escalateVirtualRole',
      element,
      label: '升级目标虚拟角色',
      description: '锚定当前审批人(其部门的上级负责人接管);配置后优先于用户/角色',
      getOptions: () => [{ value: '', label: '(未指定)' }, ...ESCALATE_VIRTUAL_ROLE_OPTIONS],
      getValue: () => getTimeoutAttr(element, 'escalateToVirtualRole'),
      setValue: value => setTimeoutAttr(element, injector, 'escalateToVirtualRole', value),
    }, injector),
    selectEntry({
      id: 'dsh-timeout-escalateRole',
      element,
      label: '升级目标角色',
      description: '超时后任务升级到的角色',
      getOptions: () => roleOptions(),
      getValue: () => getTimeoutAttr(element, 'escalateToRoleId'),
      setValue: value => setTimeoutAttr(element, injector, 'escalateToRoleId', value),
    }, injector),
    textFieldEntry({
      id: 'dsh-timeout-escalateUser',
      element,
      label: '升级目标用户 ID',
      description: '可选;优先于实体角色,低于虚拟角色',
      getValue: () => getTimeoutAttr(element, 'escalateToUserId'),
      setValue: value => setTimeoutAttr(element, injector, 'escalateToUserId', value),
    }, injector),
  )

  // --- SoD 职责分离(三个固定规则勾选) ---
  for (const rule of SOD_RULE_TYPES) {
    entries.push(
      checkboxEntry({
        id: `dsh-sod-${rule.value}`,
        element,
        label: rule.label,
        description: '',
        getValue: () => hasSodRule(element, rule.value),
        setValue: value => toggleSodRule(element, injector, rule.value, value),
      }),
    )
  }

  // --- 会签计票(design 2026-09-15;三种 task 统一):完成条件由引擎按计票规则生成 ---
  entries.push(...votingRuleEntries(element, injector, readMappingTargetRoots(element),
    ''))

  return entries
}

/** 本节点输出映射的 target 根变量去重清单(votingRule 表决变量下拉用)。 */
function readMappingTargetRoots(element: BpmnElement): () => string[] {
  return () => {
    const container = findDshElement(element, 'dsh:OutputMappings')
    if (!container) return []
    const items = (container.get('mapping') as BpmnModdleElement[]) ?? []
    const roots = items
      .map(m => ((m.get('target') as string) ?? '').split('.')[0].trim())
      .filter(Boolean)
    return [...new Set(roots)]
  }
}

/**
 * 会签计票 entries(design 2026-09-15 §4.2;三种 task 统一)。
 *
 * <p>配置 {@code dsh:votingRule}:表决变量下拉、通过值/通过票数/否决票数(可空)
 * 文本项。配置后引擎按值聚合 {@code dsh_passCount_<taskId>} /
 * {@code dsh_rejectCount_<taskId>}(userTask 在提交端点,ServiceTask 在多实例
 * end listener),parse 时自动生成完成条件,完成条件输入框随之隐藏。
 *
 * @param readVariableOptions 表决变量下拉选项(userTask / DSH backend task =
 *                            本节点输出映射 target 根变量;普通 ServiceTask =
 *                            已声明的上下文变量——delegate 代码 setVariable 写入)
 * @param variableDescription 表决变量输入框的说明文案(按变量来源差异描述)
 */
function votingRuleEntries(
  element: BpmnElement,
  injector: Injector,
  readVariableOptions: () => string[],
  variableDescription: string,
): Entry[] {
  const getVotingAttr = (attr: string): string => {
    const rule = findDshElement(element, 'dsh:VotingRule')
    return rule ? ((rule.get(attr) as string) ?? '') : ''
  }
  const setVotingAttr = (attr: string, value: string): void => {
    const trimmed = value.trim()
    if (attr === 'variable' && !trimmed) {
      // 表决变量清空 = 整条计票规则移除(其余属性随之失效)
      removeDshElement(element, injector, 'dsh:VotingRule')
      return
    }
    upsertDshElement(element, injector, 'dsh:VotingRule', {
      [attr]: trimmed || undefined,
    })
  }
  return [
    selectEntry({
      id: 'dsh-voting-variable',
      element,
      label: '表决变量',
      description: variableDescription,
      getOptions: () => [
        { value: '', label: '(不启用计票)' },
        ...readVariableOptions().map(t => ({ value: t, label: t })),
      ],
      getValue: () => getVotingAttr('variable'),
      setValue: value => setVotingAttr('variable', value ?? ''),
    }, injector),
    textFieldEntry({
      id: 'dsh-voting-passValue',
      element,
      label: '通过值',
      description: '',
      getValue: () => getVotingAttr('passValue'),
      setValue: value => setVotingAttr('passValue', value),
    }, injector),
    textFieldEntry({
      id: 'dsh-voting-passCount',
      element,
      label: '通过票数',
      description: '',
      getValue: () => getVotingAttr('passCount'),
      setValue: value => setVotingAttr('passCount', value),
    }, injector),
    textFieldEntry({
      id: 'dsh-voting-rejectCount',
      element,
      label: '否决票数',
      description: '',
      getValue: () => getVotingAttr('rejectCount'),
      setValue: value => setVotingAttr('rejectCount', value),
    }, injector),
  ]
}

/**
 * async + failedJobRetryTimeCycle 公共 entries(ServiceTask 组使用)。
 *
 * <p>重试周期存为 extensionElements 子元素:
 * <pre>{@code
 * <extensionElements>
 *   <flowable:failedJobRetryTimeCycle>R5/PT1M</flowable:failedJobRetryTimeCycle>
 * </extensionElements>
 * }</pre>
 *
 * <p>引擎仅对 async 任务的异步 Job 应用重试周期;同步任务抛异常时事务
 * 立即回滚,无重试。字段描述已注明该依赖关系。
 */
function asyncAndRetryEntries(element: BpmnElement, injector: Injector): Entry[] {
  const modeling = injector.get<ModelingService>('modeling')
  const bo = element.businessObject
  return [
    checkboxEntry({
      id: 'flowable-async',
      element,
      label: '异步执行 (async)',
      description: '',
      getValue: () => Boolean(bo.get('async')),
      setValue: value => modeling.updateProperties(element, { async: value }),
    }),
    textFieldEntry({
      id: 'flowable-retry-cycle',
      element,
      label: '失败重试策略',
      description:
        'ISO-8601 循环,如 R5/PT1M = 最多 5 次、每次隔 1 分钟;需先勾选异步执行',
      // 联动:未勾选异步时禁用;勾选切换走命令栈,面板重建 entries 后本值重新求值
      disabled: !Boolean(bo.get('async')),
      getValue: () => getDshText(element, 'flowable:FailedJobRetryTimeCycle'),
      setValue: (value) => {
        if (value && value.trim()) {
          upsertDshElement(element, injector, 'flowable:FailedJobRetryTimeCycle', {
            text: value.trim(),
          })
        } else {
          removeDshElement(element, injector, 'flowable:FailedJobRetryTimeCycle')
        }
      },
    }, injector),
  ]
}

/** ServiceTask 的 Flowable 实现方式配置组 entries(delegateExpression + async + 失败重试;expression 不提供画布入口,定制 delegate 或 DSH backend task 二选一)。 */
function serviceTaskFlowableEntries(element: BpmnElement, injector: Injector): Entry[] {
  const modeling = injector.get<ModelingService>('modeling')
  const bo = element.businessObject
  return [
    textFieldEntry({
      id: 'flowable-delegateExpression',
      element,
      label: '委托表达式 (delegateExpression)',
      description:
        '',
      getValue: () => ((bo.get('delegateExpression') as string) ?? ''),
      setValue: value =>
        modeling.updateProperties(element, {
          delegateExpression: value && value.trim() ? value : undefined,
        }),
    }, injector),
    ...asyncAndRetryEntries(element, injector),
  ]
}

// ---------------------------------------------------------------------------
// ServiceTask 多实例与三种 task 统一计票(2026-09-15)
// ---------------------------------------------------------------------------

/** 该元素的多实例是否为 BPMN 多实例(非标准循环)。 */
function hasMultiInstance(element: BpmnElement): boolean {
  const loop = element.businessObject.get('loopCharacteristics') as BpmnModdleElement | undefined
  return !!loop && loop.$type === 'bpmn:MultiInstanceLoopCharacteristics'
}

/**
 * 普通 ServiceTask(定制 delegate)的多实例配置组 entries(集合形式)。
 *
 * <p>只在该节点已是多实例(扳手菜单选了并行/串行)时由 getGroups 挂载:
 * <ul>
 *   <li>集合变量 (collection):下拉选择已声明的 array 上下文变量,实例数=数组
 *       长度,写 flowable:collection(纯变量名,引擎编译为 JUEL 表达式)。</li>
 *   <li>元素变量 (elementVariable):引擎逐实例注入的元素变量名,须与 Java 代码
 *       {@code execution.getVariable(...)} 读取的变量名一致(教程约定,
 *       发布校验查非空与重名)。</li>
 *   <li>完成条件 (completionCondition):JUEL,如 ${nrOfCompletedInstances >= 1}
 *       (任一完成即收,其余实例自动跳过);留空=全部完成;配了 votingRule 时隐藏
 *       (引擎按计票规则生成,手写被发布校验拒绝)。</li>
 * </ul>
 */
function serviceTaskMultiInstanceEntries(element: BpmnElement, injector: Injector): Entry[] {
  const modeling = injector.get<ModelingService>('modeling')
  const loop = element.businessObject.get('loopCharacteristics') as BpmnModdleElement

  const arrayVariableNames = (): string[] =>
    readContextDeclarations(injector)
      .filter(v => v.get('type') === 'array')
      .map(v => (v.get('name') as string) ?? '')
      .filter(Boolean)

  const entries: Entry[] = [
    selectEntry({
      id: 'dsh-service-mi-collection',
      element,
      label: '集合变量 (collection)',
      description:
        '',
      getOptions: () => {
        const arrays = arrayVariableNames()
        const current = ((loop.get('collection') as string) ?? '').trim()
        // 现值不在 array 声明内(手改 XML/声明变更)保留为悬空选项,交发布校验拒绝
        const dangling = current && !arrays.includes(current)
          ? [{ value: current, label: `${current} (非 array 声明)` }] : []
        return [
          { value: '', label: '(未选择)' },
          ...arrays.map(name => ({ value: name, label: name })),
          ...dangling,
        ]
      },
      getValue: () => ((loop.get('collection') as string) ?? '').trim(),
      setValue: value =>
        modeling.updateModdleProperties(element, loop, {
          collection: value || undefined,
        }),
    }, injector),
    textFieldEntry({
      id: 'dsh-service-mi-elementVariable',
      element,
      label: '元素变量 (elementVariable)',
      description:
        '不得与已声明上下文变量重名(发布校验拒绝)',
      getValue: () => ((loop.get('elementVariable') as string) ?? ''),
      setValue: value =>
        modeling.updateModdleProperties(element, loop, {
          elementVariable: value && value.trim() ? value.trim() : undefined,
        }),
    }, injector),
  ]

  // 配了 votingRule 时完成条件由引擎生成,不提供手写入口(同 userTask)
  if (!findDshElement(element, 'dsh:VotingRule')) {
    entries.push(miCompletionConditionEntry(element, injector, loop))
  }
  return entries
}

/**
 * 多实例完成条件 entry(userTask 由社区组提供,普通 ServiceTask 与 DSH backend
 * task 共用):写 {@code <completionCondition>} 子元素(FormalExpression 正文)。
 * 配了 votingRule 时不挂载(引擎按计票规则生成,手写被发布校验拒绝)。
 */
function miCompletionConditionEntry(
  element: BpmnElement,
  injector: Injector,
  loop: BpmnModdleElement,
): Entry {
  const modeling = injector.get<ModelingService>('modeling')
  const moddle = injector.get<ModdleService>('moddle')
  return textFieldEntry({
    id: 'dsh-mi-completionCondition',
    element,
    label: '完成条件',
    description:
      '',
    getValue: () => {
      const condExpr = loop.get('completionCondition') as BpmnModdleElement | undefined
      return condExpr ? ((condExpr.get('body') as string) ?? '') : ''
    },
    setValue: (value) => {
      const trimmed = value?.trim() ?? ''
      modeling.updateModdleProperties(element, loop, {
        completionCondition: trimmed
          ? moddle.create('bpmn:FormalExpression', { body: trimmed })
          : undefined,
      })
    },
  }, injector)
}

/**
 * DSH backend task 的配置组 entries(design 2026-09-14 §3.3;多实例与计票扩展
 * 2026-09-15)。
 *
 * <p>元素是含 {@code dsh:backendTask} 扩展的 ServiceTask;delegateExpression
 * 固定绑定 {@code ${dshBackendTaskDelegate}}、async 固定 true(创建时由 palette
 * 一次性写入,不提供编辑入口)。组内:
 * <ul>
 *   <li>backend profile:单实例为下拉(注册表活跃实例,写 backendProfileUrl 属性);
 *       多实例为列表(每行一个活跃实例,第 i 实例绑第 i 个,行数=loopCardinality,
 *       写 {@code <dsh:backendProfile>} 子元素列表,增删行自动同步实例数)。</li>
 *   <li>多实例完成条件:配了 votingRule 时隐藏(同 userTask)。</li>
 *   <li>失败重试:编辑 {@code flowable:failedJobRetryTimeCycle}(async job 重试)。</li>
 *   <li>User Prompt 弹窗:复用 {@code userPromptModalEntry}(与 user task 无差别,
 *       含变量插入 / JSON 骨架 / 输出映射编辑 / 预览)。</li>
 *   <li>skillRefs:复用 {@code skillRefsEntry}(选项同样来自应用绑定的 SkillHub)。</li>
 *   <li>会签计票:表决变量下拉=本节点输出映射 target 根变量(delegate 映射写入)。</li>
 * </ul>
 */
function backendTaskDshEntries(element: BpmnElement, injector: Injector): Entry[] {
  const entries: Entry[] = []
  const multiInstance = hasMultiInstance(element)

  // --- backend profile:单实例下拉 / 多实例逐实例列表 ---
  if (multiInstance) {
    entries.push(backendProfileListEntry(element, injector))
    if (!findDshElement(element, 'dsh:VotingRule')) {
      entries.push(miCompletionConditionEntry(
        element, injector, element.businessObject.get('loopCharacteristics') as BpmnModdleElement))
    }
  } else {
    entries.push(
      selectEntry({
        id: 'dsh-backend-profile',
        element,
        label: 'Backend Profile 实例（留空发布会拒绝）',
        description: '',
        getOptions: () => [
          {
            value: '',
            label: currentBackendProfiles.length === 0 ? '(未配置——注册表无活跃实例)' : '(未配置)',
          },
          ...currentBackendProfiles.map(p => ({
            value: p.url,
            label: `${p.name} (${p.url}${p.llmLabel ? `, LLM: ${p.llmLabel}` : ''})`,
          })),
        ],
        getValue: () => {
          const el = findDshElement(element, 'dsh:BackendTask')
          return el ? ((el.get('backendProfileUrl') as string) ?? '') : ''
        },
        setValue: (value) => {
          upsertDshElement(element, injector, 'dsh:BackendTask', { backendProfileUrl: value })
        },
      }, injector),
    )
  }

  // --- 失败重试(async 固定 true,重试周期可编辑;耗尽走异常边界事件) ---
  entries.push(
    textFieldEntry({
      id: 'dsh-backend-retry-cycle',
      element,
      label: '失败重试策略 (耗尽走异常边界事件)',
      description:
        '',
      getValue: () => getDshText(element, 'flowable:FailedJobRetryTimeCycle'),
      setValue: (value) => {
        if (value && value.trim()) {
          upsertDshElement(element, injector, 'flowable:FailedJobRetryTimeCycle', {
            text: value.trim(),
          })
        } else {
          removeDshElement(element, injector, 'flowable:FailedJobRetryTimeCycle')
        }
      },
    }, injector),
  )

  // --- User Prompt:统一弹窗(与 user task 复用同一对话框) ---
  entries.push(userPromptModalEntry(element, injector))

  // --- skillRefs:多选 checkbox 列表(与 user task 复用) ---
  const { getSkillRefs, setSkillRefs } = skillRefsAccessors(element, injector)
  entries.push(skillRefsEntry(getSkillRefs, setSkillRefs))

  // --- 会签计票(三种 task 统一):表决变量=输出映射 target(delegate 映射写入) ---
  entries.push(...votingRuleEntries(element, injector, readMappingTargetRoots(element),
    ''))

  return entries
}

/**
 * DSH backend task 多实例的逐实例 profile 列表 entry(2026-09-15)。
 *
 * <p>每行一个下拉(注册表活跃实例),第 i 行绑定第 i 个实例(引擎 delegate 按
 * {@code loopCounter} 取);「添加实例 / 删除」同步写回 {@code <dsh:backendProfile>}
 * 子元素列表与 {@code loopCardinality}(行数=实例数,永不失配)。现值不在活跃
 * 注册表(实例下线)渲染为悬空行,交发布校验拒绝。
 */
function backendProfileListEntry(element: BpmnElement, injector: Injector): Entry {
  const modeling = injector.get<ModelingService>('modeling')
  const moddle = injector.get<ModdleService>('moddle')

  /** 读当前行 URL 序列(每次渲染重读,命令栈写回后组件重挂载)。 */
  const readUrls = (): string[] => {
    const backendTask = findDshElement(element, 'dsh:BackendTask')
    if (!backendTask) return []
    return ((backendTask.get('backendProfile') as BpmnModdleElement[]) ?? [])
      .map(p => (p.get('url') as string) ?? '')
  }

  /** 写回行序列:backendProfile 子元素列表 + loopCardinality 同步行数。 */
  const writeUrls = (urls: string[]): void => {
    const backendTask = findDshElement(element, 'dsh:BackendTask')
    const loop = element.businessObject.get('loopCharacteristics') as BpmnModdleElement
    if (!backendTask || !loop) return
    modeling.updateModdleProperties(element, backendTask, {
      backendProfile: urls.map(url => moddle.create('dsh:BackendProfile', { url })),
    })
    modeling.updateModdleProperties(element, loop, {
      loopCardinality: urls.length
        ? moddle.create('bpmn:FormalExpression', { body: String(urls.length) })
        : undefined,
    })
  }

  return {
    id: 'dsh-backend-profile-list',
    component: () => {
      const urls = readUrls()
      const children: ComponentChild[] = [
        h('label', { className: 'bio-properties-panel-label' },
          `多实例 Backend Profile 列表(共 ${urls.length} 个实例)`),
        /*h('div', { className: 'bio-properties-panel-description' },
          '第 i 个实例绑定第 i 个 backend profile;行数=实例数(loopCardinality),'
          + '增删行自动同步。想多个实例绑同一 profile 就选同一 URL 多行'),*/
      ]
      if (currentBackendProfiles.length === 0 && urls.length === 0) {
        children.push(h('div', { className: 'bio-properties-panel-description' },
          '注册表无活跃实例(心跳 5 分钟内),先启动 backend profile 再配置'))
      }
      urls.forEach((url, i) => {
        const dangling = url && !currentBackendProfiles.some(p => p.url === url)
        const options: ComponentChild[] = [
          h('option', { value: '' }, '(未选择)'),
          ...currentBackendProfiles.map(p =>
            h('option', { value: p.url, selected: p.url === url },
              `${p.name} (${p.url})`)),
          ...(dangling
            ? [h('option', { value: url, selected: true }, `${url} (不在活跃注册表)`)] : []),
        ]
        children.push(
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 0' } },
            h('span', { style: { minWidth: 16 } }, `${i + 1}.`),
            h('select', {
              className: 'bio-properties-panel-select',
              style: { flex: 1 },
              onChange: (e: Event) => {
                const next = readUrls()
                next[i] = (e.target as HTMLSelectElement).value
                writeUrls(next)
              },
            }, options),
            h('button', {
              type: 'button',
              title: '删除此实例行(下方行自动上移)',
              onClick: () => writeUrls(readUrls().filter((_, j) => j !== i)),
              // 官方 bio-properties-panel-remove-entry 默认 visibility:hidden
              // (只为 collapsible header 设计),这里用内联样式保证常显
              style: {
                flexShrink: 0,
                width: 22,
                height: 22,
                padding: 0,
                border: 'none',
                borderRadius: '50%',
                background: 'none',
                color: 'var(--remove-entry-fill-color, #cc2f2b)',
                fontSize: 16,
                lineHeight: '22px',
                cursor: 'pointer',
              },
            }, '×'),
          ),
        )
      })
      children.push(
        h('button', {
          type: 'button',
          className: 'bio-properties-panel-add-entry',
          onClick: () => {
            // 默认选第一个活跃实例;无活跃实例时给空行(发布校验拦截)
            writeUrls([...readUrls(), currentBackendProfiles[0]?.url ?? ''])
          },
        }, '+ 添加实例'),
      )
      return h('div', null, children)
    },
    isEdited: (node: unknown) =>
      (node as HTMLElement).querySelectorAll('select').length > 0
      || (node as HTMLElement).querySelectorAll('button').length > 0,
  }
}

/**
 * SequenceFlow(连线)的条件表达式配置组 entries。
 *
 * <p>存储形态为 BPMN 原生子元素:
 * <pre>{@code
 * <sequenceFlow id="Flow_1" sourceRef="gw" targetRef="task">
 *   <conditionExpression xsi:type="bpmn:tFormalExpression">${days >= 3}</conditionExpression>
 * </sequenceFlow>
 * }</pre>
 *
 * <p>Flowable 引擎只识别该原生形态(解析为 SequenceFlow.conditionExpression)。
 * 不能写成 flowable:condition 属性——引擎解析器忽略未知命名空间属性,
 * 部署成功但路由永远不生效。bpmn-moddle 原生已声明该属性
 * (SequenceFlow.conditionExpression: Expression, xsi:type 序列化),
 * 无需在 dsh-moddle.ts 扩展。
 */
function sequenceFlowConditionEntries(element: BpmnElement, injector: Injector): Entry[] {
  const modeling = injector.get<ModelingService>('modeling')
  const moddle = injector.get<ModdleService>('moddle')
  const bo = element.businessObject

  /** 读条件表达式:原生 conditionExpression 元素的 body 文本。 */
  const getCondition = (): string => {
    const condExpr = bo.get('conditionExpression') as BpmnModdleElement | undefined
    if (!condExpr) return ''
    return (condExpr.get('body') as string) ?? ''
  }

  const setCondition = (value: string) => {
    const trimmed = value?.trim() ?? ''
    if (!trimmed) {
      modeling.updateProperties(element, { conditionExpression: undefined })
      return
    }
    const expr = moddle.create('bpmn:FormalExpression', { body: trimmed })
    modeling.updateProperties(element, { conditionExpression: expr })
  }

  return [
    textAreaEntry({
      id: 'flowable-sequenceflow-condition',
      element,
      label: '条件表达式 (condition)',
      description:
        'UEL 语法,如 ${days >= 3};用于排他(X)/包容(O)网关出线。序列化为 BPMN 原生 <conditionExpression> 子元素(Flowable 引擎只认这个形态)',
      rows: 2,
      monospace: true,
      getValue: getCondition,
      setValue: setCondition,
    }, injector),
  ]
}

/**
 * 排他/包容网关的默认流配置组 entries。
 *
 * <p>BPMN 原生属性 default(Gateway → SequenceFlow 引用):
 * 所有出线条件都不满足时走默认流。BPMN 规范要求默认流本身不能再带条件表达式。
 */
function gatewayDefaultFlowEntries(element: BpmnElement, injector: Injector): Entry[] {
  const modeling = injector.get<ModelingService>('modeling')
  const bo = element.businessObject
  const outgoing = (bo.get('outgoing') as BpmnModdleElement[]) ?? []

  return [
    selectEntry({
      id: 'dsh-gateway-default-flow',
      element,
      label: '默认流 (default)',
      description: '所有出线条件都不满足时走的兜底出线;BPMN 规范要求默认流不能再设条件表达式',
      getOptions: () => [
        { value: '', label: '(无默认流)' },
        ...outgoing.map((f) => {
          const id = (f.get('id') as string) ?? ''
          const name = (f.get('name') as string) ?? ''
          return { value: id, label: name ? `${name} (${id})` : id }
        }),
      ],
      getValue: () => {
        const def = bo.get('default') as BpmnModdleElement | undefined
        return def ? ((def.get('id') as string) ?? '') : ''
      },
      setValue: (value) => {
        const flow = outgoing.find(f => f.get('id') === value)
        modeling.updateProperties(element, { default: flow ?? undefined })
      },
    }, injector),
  ]
}

/** ScriptTask 的配置组 entries(scriptFormat + script,均为 BPMN 原生属性)。 */
function scriptTaskEntries(element: BpmnElement, injector: Injector): Entry[] {
  const modeling = injector.get<ModelingService>('modeling')
  const bo = element.businessObject
  return [
    selectEntry({
      id: 'bpmn-scriptFormat',
      element,
      label: '脚本语言 (scriptFormat)',
      description: 'javascript / groovy / juel(引擎需有对应脚本引擎依赖)',
      getOptions: () => [
        { value: '', label: '(未指定)' },
        { value: 'javascript', label: 'javascript' },
        { value: 'groovy', label: 'groovy' },
        { value: 'juel', label: 'juel' },
      ],
      getValue: () => (bo.get('scriptFormat') as string) ?? '',
      setValue: value =>
        modeling.updateProperties(element, { scriptFormat: value || undefined }),
    }, injector),
    textAreaEntry({
      id: 'bpmn-script',
      element,
      label: '脚本内容 (script)',
      description: '可直接读写流程变量树(context),如 execution.setVariable(\'approvalResult\', output.conclusion)',
      rows: 6,
      monospace: true,
      getValue: () => (bo.get('script') as string) ?? '',
      setValue: value =>
        modeling.updateProperties(element, {
          script: value && value.trim() ? value : undefined,
        }),
    }, injector),
  ]
}

/** CallActivity 的配置组 entries(calledElement 原生 + inheritVariables/async flowable)。 */
function callActivityEntries(element: BpmnElement, injector: Injector): Entry[] {
  const modeling = injector.get<ModelingService>('modeling')
  const bo = element.businessObject
  return [
    textFieldEntry({
      id: 'bpmn-calledElement',
      element,
      label: '调用流程 (calledElement)',
      description: '被复用的流程定义 key(process id);默认不传父流程变量,勾选继承后传入',
      getValue: () => (bo.get('calledElement') as string) ?? '',
      setValue: value =>
        modeling.updateProperties(element, {
          calledElement: value && value.trim() ? value : undefined,
        }),
    }, injector),
    checkboxEntry({
      id: 'flowable-inheritVariables',
      element,
      label: '继承流程变量 (inheritVariables)',
      description: '勾选后子流程可直接读写父流程的流程变量树(context)',
      getValue: () => Boolean(bo.get('inheritVariables')),
      setValue: value => modeling.updateProperties(element, { inheritVariables: value }),
    }),
    checkboxEntry({
      id: 'flowable-callactivity-async',
      element,
      label: '异步执行 (async)',
      description: '勾选后由 async-executor 线程池执行,不阻塞主流程',
      getValue: () => Boolean(bo.get('async')),
      setValue: value => modeling.updateProperties(element, { async: value }),
    }),
  ]
}

/**
 * Conditional Intermediate Catch Event / Boundary Event 的条件表达式配置组 entries。
 *
 * <p>存储形态为 BPMN 原生子元素:
 * <pre>{@code
 * <intermediateCatchEvent id="waitParent">
 *   <conditionalEventDefinition>
 *     <condition xsi:type="bpmn:tFormalExpression">${parentSigned == true}</condition>
 *   </conditionalEventDefinition>
 * </intermediateCatchEvent>
 * }</pre>
 *
 * <p>条件存在 {@code conditionalEventDefinition.condition} 属性上( FormalExpression),
 * 与 SequenceFlow 的 {@code conditionExpression} 是不同路径,但读写模式一致。
 */
function conditionalEventEntries(element: BpmnElement, injector: Injector): Entry[] {
  const modeling = injector.get<ModelingService>('modeling')
  const moddle = injector.get<ModdleService>('moddle')
  const bo = element.businessObject

  /** 获取 conditionalEventDefinition（事件已带该定义时存在）。 */
  const getCondDef = (): BpmnModdleElement | undefined => {
    const eventDefinitions = (bo.get('eventDefinitions') as BpmnModdleElement[]) ?? []
    return eventDefinitions.find(e => e.$type === 'bpmn:ConditionalEventDefinition')
  }

  const getCondition = (): string => {
    const condDef = getCondDef()
    if (!condDef) return ''
    const condition = condDef.get('condition') as BpmnModdleElement | undefined
    if (!condition) return ''
    return (condition.get('body') as string) ?? ''
  }

  const setCondition = (value: string) => {
    const trimmed = value?.trim() ?? ''
    const condDef = getCondDef()
    if (!condDef) return
    if (!trimmed) {
      modeling.updateModdleProperties(element, condDef, { condition: undefined })
      return
    }
    const expr = moddle.create('bpmn:FormalExpression', { body: trimmed })
    modeling.updateModdleProperties(element, condDef, { condition: expr })
  }

  return [
    textAreaEntry({
      id: 'bpmn-conditional-expression',
      element,
      label: '条件表达式 (condition)',
      description: 'UEL 语法,如 ${parentSigned == true};流程变量变化时引擎自动重新评估,为真则继续',
      rows: 2,
      monospace: true,
      getValue: getCondition,
      setValue: setCondition,
    }, injector),
  ]
}

// ---------------------------------------------------------------------------
// provider 与 DI 模块
// ---------------------------------------------------------------------------

/**
 * properties panel provider:向内置 groups 追加 DSH / Flowable 组。
 *
 * <p>通过 bpmn-js DI 注册(additionalModules),构造注入 propertiesPanel 与 injector。
 */
function DshPropertiesProvider(this: unknown, propertiesPanel: {
  registerProvider: (priority: number, provider: unknown) => void
}, injector: Injector): void {
  // registerProvider 注册时会立即校验 #getGroups(element),必须先定义再注册
  const self = this as {
    getGroups: (element: BpmnElement) => (groups: unknown[]) => unknown[]
  }
  self.getGroups = (element: BpmnElement) => (groups: unknown[]) => {
    if (is(element, 'bpmn:Process')) {
      groups.push({
        id: 'dsh-context-variables',
        label: '流程上下文变量',
        entries: contextVariablesEntries(element, injector),
      })
    } else if (is(element, 'bpmn:UserTask')) {
      groups.push({
        id: 'dsh-user-task',
        label: 'User Task 配置',
        entries: userTaskDshEntries(element, injector),
      })
    } else if (is(element, 'bpmn:ServiceTask')) {
      if (findDshElement(element, 'dsh:BackendTask')) {
        // DSH backend task:渲染 backend 配置组,跳过普通 ServiceTask 的
        // "Flowable 实现方式"组(delegateExpression/async 已固定绑定,不允许改)
        groups.push({
          id: 'dsh-backend-task',
          label: 'Backend Task 配置',
          entries: backendTaskDshEntries(element, injector),
        })
      } else {
        groups.push({
          id: 'dsh-service-task',
          label: 'Flowable 实现方式',
          entries: serviceTaskFlowableEntries(element, injector),
        })
        // 多实例(扳手菜单选了并行/串行后出现):集合形式——实例数=array 长度
        if (hasMultiInstance(element)) {
          groups.push({
            id: 'dsh-service-task-mi',
            label: '多实例',
            entries: serviceTaskMultiInstanceEntries(element, injector),
          })
        }
        groups.push({
          id: 'dsh-service-task-voting',
          label: '会签计票',
          entries: votingRuleEntries(element, injector,
            () => readContextDeclarations(injector).map(v => (v.get('name') as string) ?? ''),
            ''),
        })
      }
    } else if (is(element, 'bpmn:SequenceFlow')) {
      groups.push({
        id: 'flowable-sequenceflow',
        label: 'Flowable 条件表达式',
        entries: sequenceFlowConditionEntries(element, injector),
      })
    } else if (isAny(element, ['bpmn:ExclusiveGateway', 'bpmn:InclusiveGateway'])) {
      groups.push({
        id: 'dsh-gateway',
        label: '网关配置',
        entries: gatewayDefaultFlowEntries(element, injector),
      })
    } else if (is(element, 'bpmn:ScriptTask')) {
      groups.push({
        id: 'bpmn-script-task',
        label: '脚本任务配置',
        entries: scriptTaskEntries(element, injector),
      })
    } else if (is(element, 'bpmn:CallActivity')) {
      groups.push({
        id: 'flowable-call-activity',
        label: '调用活动配置',
        entries: callActivityEntries(element, injector),
      })
    }

    // Conditional Intermediate Catch Event / Boundary Event 的条件表达式
    if (isAny(element, ['bpmn:IntermediateCatchEvent', 'bpmn:BoundaryEvent'])) {
      const eventDefinitions = (element.businessObject.get('eventDefinitions') as BpmnModdleElement[]) ?? []
      if (eventDefinitions.some(e => e.$type === 'bpmn:ConditionalEventDefinition')) {
        groups.push({
          id: 'bpmn-conditional-event',
          label: '条件表达式',
          entries: conditionalEventEntries(element, injector),
        })
      }
    }

    let result = groups
    // UserTask 的多实例派发只认集合形式:collection/elementVariable/assignee 由引擎
    // 部署时按候选角色自动补齐(DshBpmnParseHandler),loopCardinality 计数形式会让
    // 引擎放弃补齐、任务无办理人,隐藏该输入框。配了 dsh:votingRule(会签计票)时
    // completionCondition 也隐藏——完成条件由引擎按计票规则自动生成,
    // 手写会被发布校验拒绝(矛盾配置)。
    if (is(element, 'bpmn:UserTask')) {
      const hideCompletion = Boolean(findDshElement(element, 'dsh:VotingRule'))
      result = result.map((g: any) =>
        g.id === 'multiInstance'
          ? {
            ...g,
            entries: g.entries.filter(
              (entry: any) =>
                entry.id !== 'loopCardinality'
                  && !(hideCompletion && entry.id === 'completionCondition'),
            ),
          }
          : g,
      )
    }
    // ServiceTask 的多实例字段由 DSH 面板接管(普通节点=集合形式 collection/
    // elementVariable/完成条件;backend task=profile 列表行数即 loopCardinality),
    // 隐藏社区 multiInstance 组(Loop cardinality / Completion condition)
    if (is(element, 'bpmn:ServiceTask')) {
      result = result.filter((g: any) => g.id !== 'multiInstance')
    }
    // Flowable 的 ReceiveTask 不消费 messageRef,隐藏误导性的 Message 组
    if (is(element, 'bpmn:ReceiveTask')) {
      result = result.filter((g: any) => g.id !== 'message')
    }
    return result
  }
  propertiesPanel.registerProvider(500, self)
}

(DshPropertiesProvider as unknown as { $inject: string[] }).$inject = [
  'propertiesPanel',
  'injector',
]

/** bpmn-js additionalModules 形态的 DI 模块。 */
export const DshPropertiesProviderModule = {
  __init__: ['dshPropertiesProvider'],
  dshPropertiesProvider: ['type', DshPropertiesProvider],
}
