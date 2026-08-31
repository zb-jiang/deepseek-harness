/**
 * DSH BPMN moddle 扩展描述符。
 *
 * XML 契约必须与 Flowable 引擎侧 DshBpmnExtensionParser 严格对齐:
 * namespace 为 http://dsh.ai/bpmn,元素 local name 为 assignmentRule /
 * outputSchema / systemPrompt / userPrompt / skillRef / actionPolicy /
 * timeoutPolicy / sodRule,引擎解析按 local name 取值。
 *
 * 已移除:InputSchema(上游字段从 process variables 树读取,无需单独声明)、
 * RoutingRule(路由改为走 SequenceFlow 原生 conditionExpression)。
 *
 * tagAlias: 'lowerCase' 使类型名 AssignmentRule 序列化为 <dsh:assignmentRule>。
 */

/** dsh: 命名空间 URI(对齐引擎 DshBpmnExtensionParser.DSH_NAMESPACE)。 */
export const DSH_NAMESPACE = 'http://dsh.ai/bpmn'

export const dshModdleDescriptor = {
  name: 'Dsh',
  uri: DSH_NAMESPACE,
  prefix: 'dsh',
  xml: {
    tagAlias: 'lowerCase',
  },
  types: [
    {
      // 人工节点责任规则:<dsh:assignmentRule candidateRoleId="..." taskStrategy="single"/>
      name: 'AssignmentRule',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:UserTask'] },
      properties: [
        { name: 'candidateRoleId', isAttr: true, type: 'String' },
        { name: 'taskStrategy', isAttr: true, type: 'String' },
      ],
    },
    // 文本元素:<dsh:outputSchema>{...JSON...}</dsh:outputSchema> 等,值存 text 属性(isBody)
    {
      name: 'OutputSchema',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:UserTask'] },
      properties: [{ name: 'text', isBody: true, type: 'String' }],
    },
    {
      name: 'SystemPrompt',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:UserTask'] },
      properties: [{ name: 'text', isBody: true, type: 'String' }],
    },
    {
      name: 'UserPrompt',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:UserTask'] },
      properties: [{ name: 'text', isBody: true, type: 'String' }],
    },
    {
      // 多值 skill 引用:<dsh:skillRef>name</dsh:skillRef>(每个 skill 一个元素)
      name: 'SkillRef',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:UserTask'] },
      properties: [{ name: 'text', isBody: true, type: 'String' }],
    },
    {
      // 动作策略容器:<dsh:actionPolicy><dsh:timeoutPolicy .../><dsh:sodRule .../></dsh:actionPolicy>
      name: 'ActionPolicy',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:UserTask'] },
      properties: [
        { name: 'timeoutPolicy', type: 'dsh:TimeoutPolicy' },
        { name: 'sodRule', isMany: true, type: 'dsh:SodRule' },
      ],
    },
    {
      name: 'TimeoutPolicy',
      superClass: ['Element'],
      properties: [
        { name: 'duration', isAttr: true, type: 'String' },
        { name: 'escalateToRoleId', isAttr: true, type: 'String' },
        { name: 'escalateToUserId', isAttr: true, type: 'String' },
      ],
    },
    {
      name: 'SodRule',
      superClass: ['Element'],
      properties: [{ name: 'type', isAttr: true, type: 'String' }],
    },
  ],
}

/**
 * Flowable 命名空间最小描述符:覆盖 Web Console 需要编辑的属性。
 *
 * - ServiceTask/SendTask/BusinessRuleTask:flowable:class / expression / delegateExpression
 * - ServiceTask/SendTask/BusinessRuleTask:failedJobRetryTimeCycle
 *   (失败重试周期,extensionElements 子元素;引擎仅对 async 任务的异步 Job 生效)
 * - Task/CallActivity:async(异步执行,async-executor 线程池)
 * - CallActivity:inheritVariables(子流程继承流程变量树)
 * - UserTask:candidateUsers / candidateGroups(人工节点兜底)
 *
 * 官方 bpmn-js-properties-panel 的 CamundaPlatform provider 绑定 camunda: 命名空间,
 * 对 Flowable 引擎无效,因此 Flowable 属性组由 DshPropertiesProvider 自行提供。
 */
export const flowableModdleDescriptor = {
  name: 'Flowable',
  uri: 'http://flowable.org/bpmn',
  prefix: 'flowable',
  xml: {
    tagAlias: 'lowerCase',
  },
  types: [
    {
      name: 'AsyncBehaviour',
      extends: ['bpmn:Task', 'bpmn:CallActivity'],
      properties: [{ name: 'async', isAttr: true, type: 'Boolean' }],
    },
    {
      // 自动类任务的三种实现方式,Flowable 引擎按属性名路由到对应执行器
      name: 'ImplementationBehaviour',
      extends: ['bpmn:ServiceTask', 'bpmn:SendTask', 'bpmn:BusinessRuleTask'],
      properties: [
        { name: 'class', isAttr: true, type: 'String' },
        { name: 'expression', isAttr: true, type: 'String' },
        { name: 'delegateExpression', isAttr: true, type: 'String' },
      ],
    },
    {
      // 失败重试周期:<flowable:failedJobRetryTimeCycle>R5/PT1M</flowable:failedJobRetryTimeCycle>
      // (extensionElements 子元素;配合 async 使用,同步任务抛异常时事务直接回滚无重试)
      name: 'FailedJobRetryTimeCycle',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:ServiceTask', 'bpmn:SendTask', 'bpmn:BusinessRuleTask'] },
      properties: [{ name: 'text', isBody: true, type: 'String' }],
    },
    {
      name: 'CallActivityBehaviour',
      extends: ['bpmn:CallActivity'],
      properties: [
        { name: 'inheritVariables', isAttr: true, type: 'Boolean' },
      ],
    },
    {
      name: 'CandidateBehaviour',
      extends: ['bpmn:UserTask'],
      properties: [
        { name: 'candidateUsers', isAttr: true, type: 'String' },
        { name: 'candidateGroups', isAttr: true, type: 'String' },
      ],
    },
    // 注意:SequenceFlow 的条件表达式不在此声明——引擎只识别 BPMN 原生
    // <conditionExpression xsi:type="bpmn:tFormalExpression"> 子元素,
    // bpmn-moddle 原生已声明该属性,由 DshPropertiesProvider 直接读写。
  ],
}
