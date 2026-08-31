/**
 * DSH 自定义 properties panel provider。
 *
 * <p>按元素类型分组渲染:
 * <ul>
 *   <li>{@code bpmn:UserTask}(人工节点) → "DSH 人工节点配置"组:
 *       责任规则(角色下拉 + 处理策略)、输出 Process Variables 定义、
 *       systemPrompt/userPrompt/skillRefs、动作策略(超时升级 + SoD)。</li>
 *   <li>{@code bpmn:ServiceTask}(自动节点) → "DSH 自动节点配置"组:
 *       delegateExpression 文本(默认 ${dshServiceTaskDelegate},可填自定义委托)
 *       + async 异步开关 + failedJobRetryTimeCycle 失败重试策略。</li>
 *   <li>{@code bpmn:SequenceFlow}(连线) → "Flowable 条件表达式"组:
 *       conditionExpression 条件表达式(BPMN 原生子元素,排他/包容网关出线路由)。</li>
 *   <li>{@code bpmn:ExclusiveGateway / InclusiveGateway}(排他/包容网关) →
 *       "网关配置"组:默认流 default(BPMN 原生属性,条件全不满足时的兜底出线)。</li>
 *   <li>{@code bpmn:ScriptTask}(脚本任务) → "脚本任务配置"组:
 *       scriptFormat + script(BPMN 原生属性,引擎内执行脚本加工流程变量)。</li>
 *   <li>{@code bpmn:SendTask / BusinessRuleTask} → "Flowable 实现方式"组:
 *       class / expression / delegateExpression(flowable: 命名空间,三选一)
 *       + async + failedJobRetryTimeCycle。</li>
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
 *   <li>废弃 inputSchema:上游字段直接从 BPMN 流程变量树(context)读取;
 *       保留 outputSchema(标签"输出 Process Variables 定义"),DSH agent 校验
 *       complete 输出后写入流程变量树供下游消费。</li>
 *   <li>过滤 ReceiveTask 的 Message 组:Flowable 引擎的 ReceiveTask 实现不消费
 *       messageRef,该组对 DSH 用户是误导,因此在属性面板中隐藏。</li>
 * </ul>
 *
 * <p>读写均走 bpmn-js 命令栈({@code modeling.updateModdleProperties} /
 * {@code modeling.updateProperties}),支持撤销重做;XML 序列化契约由
 * {@code dsh-moddle.ts} 保证与引擎 {@code DshBpmnExtensionParser} 对齐。
 */
import { is, isAny } from 'bpmn-js/lib/util/ModelUtil'
import {
  CheckboxEntry,
  JsonEditorEntry,
  SelectEntry,
  TextAreaEntry,
  TextFieldEntry,
  isCheckboxEntryEdited,
  isJsonEditorEntryEdited,
  isSelectEntryEdited,
  isTextAreaEntryEdited,
  isTextFieldEntryEdited,
  type CheckboxEntryProps,
  type Entry,
  type JsonEditorEntryProps,
  type SelectEntryProps,
  type TextAreaEntryProps,
  type TextFieldEntryProps,
} from '@bpmn-io/properties-panel'
import type { AppRoleDto } from '../api/roles'

/** bpmn-js 图元素的最小结构(provider 只用 businessObject)。 */
type BpmnElement = { businessObject: BpmnModdleElement }

/** moddle 元素(动态属性访问)。 */
type BpmnModdleElement = {
  $type: string
  get: (name: string) => unknown
} & Record<string, unknown>

/** DI 服务容器(modeling/moddle 由 injector.get 获取)。 */
type Injector = { get: <T = unknown>(name: string) => T }

/** modeling 服务:updateModdleProperties 走命令栈可撤销。 */
interface ModelingService {
  updateProperties: (element: unknown, props: Record<string, unknown>) => void
  updateModdleProperties: (
    element: unknown,
    moddleElement: unknown,
    props: Record<string, unknown>,
  ) => void
}

/** moddle 服务:创建扩展元素实例。 */
interface ModdleService {
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

/** SoD 规则类型,引擎 DshExtensionProperties.SodRule 的三个合法值。 */
const SOD_RULE_TYPES = [
  { value: 'not-applicant', label: '审批人不得为申请人 (not-applicant)' },
  { value: 'mutex-node', label: '同实例互斥节点 (mutex-node)' },
  { value: 'countersign-distinct', label: '会签人不重复 (countersign-distinct)' },
] as const

/** 人工节点处理策略。 */
const TASK_STRATEGIES = [
  { value: 'single', label: '单人 (single)' },
  { value: 'countersign', label: '会签 (countersign)' },
  { value: 'sequential', label: '串签 (sequential)' },
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
function findDshElement(
  element: BpmnElement,
  type: string,
): BpmnModdleElement | undefined {
  const ext = getExtensionElements(element)
  if (!ext) return undefined
  const values = (ext.get('values') as BpmnModdleElement[]) ?? []
  return values.find(v => v.$type === type)
}

/** 确保 extensionElements 存在(不存在则创建,走命令栈);返回它。 */
function ensureExtensionElements(
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
function upsertDshElement(
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
function removeDshElement(
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

/** 文本元素(outputSchema 等)当前值;无元素返回空串。 */
function getDshText(element: BpmnElement, type: string): string {
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

/** timeoutPolicy 属性读:duration/escalateToRoleId/escalateToUserId。 */
function getTimeoutAttr(element: BpmnElement, attr: string): string {
  const policy = findDshElement(element, 'dsh:ActionPolicy')
  if (!policy) return ''
  const timeout = policy.get('timeoutPolicy') as BpmnModdleElement | null
  if (!timeout) return ''
  return (timeout.get(attr) as string) ?? ''
}

/** timeoutPolicy 属性写:无容器逐层创建;duration 置空时移除 timeoutPolicy。 */
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
    const attrs = ['duration', 'escalateToRoleId', 'escalateToUserId'].filter(
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

/** select entry 包装(候选角色/处理策略等下拉)。 */
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

/** textarea entry 包装(多行文本,如 systemPrompt)。 */
function textAreaEntry(props: TextAreaEntryProps, injector: Injector): Entry {
  return wrapEntry(
    props.id,
    p => TextAreaEntry({ debounce: injector.get('debounceInput'), ...props, ...p }),
    isTextAreaEntryEdited,
  )
}

/** json editor entry 包装(outputSchema)。 */
function jsonEditorEntry(props: JsonEditorEntryProps, injector: Injector): Entry {
  return wrapEntry(
    props.id,
    p => JsonEditorEntry({ debounce: injector.get('debounceInput'), ...props, ...p }),
    isJsonEditorEntryEdited,
  )
}

/** checkbox entry 包装(SoD 勾选等)。 */
function checkboxEntry(props: CheckboxEntryProps): Entry {
  return wrapEntry(props.id, p => CheckboxEntry({ ...props, ...p }), isCheckboxEntryEdited)
}

/** 角色下拉选项(含"未指定"空项);数据来自页面注入的应用角色列表。 */
function roleOptions(): Array<{ value: string; label: string }> {
  return [
    { value: '', label: '(未指定)' },
    ...currentRoles.map(r => ({ value: r.id, label: r.name })),
  ]
}

/** 文本元素 entry 通用工厂(outputSchema/systemPrompt 等)。 */
function dshTextEntry(
  element: BpmnElement,
  injector: Injector,
  type: string,
  label: string,
  description: string,
  opts: { json?: boolean; rows?: number } = {},
): Entry {
  const get = () => getDshText(element, type)
  const set = (value: string) => {
    if (value && value.trim()) {
      upsertDshElement(element, injector, type, { text: value })
    } else {
      removeDshElement(element, injector, type)
    }
  }
  const id = `dsh-${type.slice(4)}`
  if (opts.json) {
    return jsonEditorEntry({
      id,
      element,
      label,
      description,
      getValue: get,
      setValue: set,
      validate: (value) => {
        if (!value || !value.trim()) return null
        try {
          JSON.parse(value)
          return null
        } catch {
          return '不是合法的 JSON'
        }
      },
    }, injector)
  }
  return textAreaEntry({
    id,
    element,
    label,
    description,
    rows: opts.rows ?? 4,
    monospace: true,
    getValue: get,
    setValue: set,
  }, injector)
}

/** UserTask 的 DSH 配置组 entries。 */
function userTaskDshEntries(element: BpmnElement, injector: Injector): Entry[] {
  const entries: Entry[] = []

  // --- 责任规则:候选角色下拉 + 处理策略 ---
  const assignment = findDshElement(element, 'dsh:AssignmentRule')
  const getAssignmentAttr = (attr: string): string =>
    assignment ? ((assignment.get(attr) as string) ?? '') : ''
  const setAssignmentAttr = (attr: string, value: string) => {
    if (!value) {
      // 两个属性都空则移除整个元素,避免残留空 assignmentRule
      const other = attr === 'candidateRoleId' ? 'taskStrategy' : 'candidateRoleId'
      const otherValue = getAssignmentAttr(other)
      if (!otherValue) {
        removeDshElement(element, injector, 'dsh:AssignmentRule')
        return
      }
      upsertDshElement(element, injector, 'dsh:AssignmentRule', { [attr]: undefined })
      return
    }
    upsertDshElement(element, injector, 'dsh:AssignmentRule', { [attr]: value })
  }

  entries.push(
    selectEntry({
      id: 'dsh-assignment-candidateRole',
      element,
      label: '候选角色',
      description: '任务派给该角色的成员(角色继承由 task-api 展开)',
      getOptions: () => roleOptions(),
      getValue: () => getAssignmentAttr('candidateRoleId'),
      setValue: value => setAssignmentAttr('candidateRoleId', value),
    }, injector),
    selectEntry({
      id: 'dsh-assignment-taskStrategy',
      element,
      label: '处理策略',
      description: 'single 单人 / countersign 会签 / sequential 串签',
      getOptions: () => [...TASK_STRATEGIES],
      getValue: () => getAssignmentAttr('taskStrategy'),
      setValue: value => setAssignmentAttr('taskStrategy', value),
    }, injector),
  )

  // --- 输出 Process Variables 定义 + 会话配置 ---
  entries.push(
    dshTextEntry(
      element,
      injector,
      'dsh:OutputSchema',
      '输出 Process Variables 定义',
      '节点完成时必须产出的结构化字段(JSON Schema);DSH agent 校验通过后写入 BPMN 流程变量树供下游消费',
      { json: true },
    ),
    dshTextEntry(element, injector, 'dsh:SystemPrompt', 'System Prompt', '会话级 system prompt;可空', { rows: 3 }),
    dshTextEntry(element, injector, 'dsh:UserPrompt', 'User Prompt', '预填首条 user message;可含 {{execution.xxx}} 流程变量占位符', { rows: 3 }),
  )

  // --- skillRefs:textarea 每行一个 ---
  const getSkillRefs = (): string => {
    const refs = (getExtensionElements(element)?.get('values') as BpmnModdleElement[] ?? [])
      .filter(v => v.$type === 'dsh:SkillRef')
      .map(v => (v.get('text') as string) ?? '')
      .filter(s => s.trim())
    return refs.join('\n')
  }
  const setSkillRefs = (value: string) => {
    const modeling = injector.get<ModelingService>('modeling')
    const moddle = injector.get<ModdleService>('moddle')
    const ext = ensureExtensionElements(element, injector)
    const values = (ext.get('values') as BpmnModdleElement[]) ?? []
    const kept = values.filter(v => v.$type !== 'dsh:SkillRef')
    const lines = value.split('\n').map(s => s.trim()).filter(Boolean)
    const newRefs = lines.map(name => moddle.create('dsh:SkillRef', { text: name }))
    modeling.updateModdleProperties(element, ext, { values: [...kept, ...newRefs] })
  }
  entries.push(
    textAreaEntry({
      id: 'dsh-skillRefs',
      element,
      label: 'Skill 引用 (skillRefs)',
      description: '每行一个 skill 名称;供员工 PC 定时任务预装',
      rows: 3,
      monospace: true,
      getValue: getSkillRefs,
      setValue: setSkillRefs,
    }, injector),
  )

  // --- 超时升级策略 ---
  entries.push(
    textFieldEntry({
      id: 'dsh-timeout-duration',
      element,
      label: '超时时长 (duration)',
      description: 'ISO-8601 时长,如 PT24H;留空表示不超时',
      getValue: () => getTimeoutAttr(element, 'duration'),
      setValue: value => setTimeoutAttr(element, injector, 'duration', value),
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
      description: '可选;指定用户优先于角色',
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
        description: 'SoD 职责分离规则',
        getValue: () => hasSodRule(element, rule.value),
        setValue: value => toggleSodRule(element, injector, rule.value, value),
      }),
    )
  }

  return entries
}

/**
 * async + failedJobRetryTimeCycle 公共 entries
 * (ServiceTask / SendTask / BusinessRuleTask 三组共用)。
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
      description: '勾选后由 async-executor 线程池执行,不阻塞主流程;失败重试策略依赖此开关',
      getValue: () => Boolean(bo.get('async')),
      setValue: value => modeling.updateProperties(element, { async: value }),
    }),
    textFieldEntry({
      id: 'flowable-retry-cycle',
      element,
      label: '失败重试策略 (failedJobRetryTimeCycle)',
      description:
        'ISO-8601 循环,如 R5/PT1M = 最多 5 次、每次隔 1 分钟;需先勾选异步执行(引擎仅对异步 Job 应用重试)',
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

/** ServiceTask 的 Flowable 实现方式配置组 entries(delegateExpression / expression + async + 失败重试)。 */
function serviceTaskFlowableEntries(element: BpmnElement, injector: Injector): Entry[] {
  const modeling = injector.get<ModelingService>('modeling')
  const bo = element.businessObject
  return [
    textFieldEntry({
      id: 'flowable-delegateExpression',
      element,
      label: '委托表达式 (delegateExpression)',
      description:
        '${Spring Bean 名}:如 ${dshServiceTaskDelegate}(DSH 自动节点统一入口,实现 JavaDelegate)或 ${sendReminderDelegate}(自定义委托)',
      getValue: () => ((bo.get('delegateExpression') as string) ?? ''),
      setValue: value =>
        modeling.updateProperties(element, {
          delegateExpression: value && value.trim() ? value : undefined,
        }),
    }, injector),
    textFieldEntry({
      id: 'flowable-expression',
      element,
      label: '表达式 (expression)',
      description:
        'UEL 方法调用,如 ${smsSender.send(execution, phone)};Bean 与方法需自行注册',
      getValue: () => ((bo.get('expression') as string) ?? ''),
      setValue: value =>
        modeling.updateProperties(element, {
          expression: value && value.trim() ? value : undefined,
        }),
    }, injector),
    ...asyncAndRetryEntries(element, injector),
  ]
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

/**
 * SendTask/BusinessRuleTask 的 Flowable 实现方式配置组 entries。
 *
 * <p>expression / delegateExpression 二选一,引擎按存在的属性路由。
 * class(实现类)不推荐:引擎反射 new 实例,拿不到 Spring 注入,已在 UI 中移除。
 */
function autoTaskImplementationEntries(element: BpmnElement, injector: Injector): Entry[] {
  const modeling = injector.get<ModelingService>('modeling')
  const bo = element.businessObject
  const implField = (
    attr: 'expression' | 'delegateExpression',
    label: string,
    description: string,
  ): Entry =>
    textFieldEntry({
      id: `flowable-impl-${attr}`,
      element,
      label,
      description,
      getValue: () => (bo.get(attr) as string) ?? '',
      setValue: value =>
        modeling.updateProperties(element, {
          [attr]: value && value.trim() ? value : undefined,
        }),
    }, injector)
  return [
    implField('expression', '表达式 (expression)', 'UEL 方法调用,如 ${mailer.send(execution)};Bean 与方法需自行注册'),
    implField('delegateExpression', '委托表达式 (delegateExpression)', '如 ${dshServiceTaskDelegate};二选一,引擎按属性路由'),
    ...asyncAndRetryEntries(element, injector),
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
    if (is(element, 'bpmn:UserTask')) {
      groups.push({
        id: 'dsh-user-task',
        label: 'DSH 人工节点配置',
        entries: userTaskDshEntries(element, injector),
      })
    } else if (is(element, 'bpmn:ServiceTask')) {
      groups.push({
        id: 'dsh-service-task',
        label: 'Flowable 实现方式',
        entries: serviceTaskFlowableEntries(element, injector),
      })
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
    } else if (isAny(element, ['bpmn:SendTask', 'bpmn:BusinessRuleTask'])) {
      groups.push({
        id: 'flowable-implementation',
        label: 'Flowable 实现方式',
        entries: autoTaskImplementationEntries(element, injector),
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

    // Flowable 的 ReceiveTask 不消费 messageRef,隐藏误导性的 Message 组
    if (is(element, 'bpmn:ReceiveTask')) {
      return groups.filter((g: any) => g.id !== 'message')
    }

    return groups
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
