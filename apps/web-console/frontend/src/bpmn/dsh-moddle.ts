/**
 * DSH BPMN moddle 扩展描述符。
 *
 * XML 契约必须与 Flowable 引擎侧 DshBpmnExtensionParser 严格对齐:
 * namespace 为 http://dsh.ai/bpmn,元素 local name 为 assignmentRule /
 * userPrompt / skillRef / actionPolicy / timeoutPolicy / sodRule /
 * contextVariables / contextVariable / field / outputMappings / mapping,
 * 引擎解析按 local name 取值。
 *
 * Process Context 机制(design 2026-09-01):
 * - process 级 <dsh:contextVariables>:流程上下文变量声明(八种类型,
 *   object 挂字段清单,array 声明 itemType);
 * - userTask 级 <dsh:outputMappings>:员工提交 JSON → 上下文变量的映射;
 * - 代码节点(delegate/脚本/DMN)读写变量都在代码内直接 getVariable/setVariable,
 *   无需也不再有节点级标注元素。
 *
 * tagAlias: 'lowerCase' 使类型名 AssignmentRule 序列化为 <dsh:assignmentRule>;
 * 同理 ContextVariable → <dsh:contextVariable>。
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
      // 人工节点责任规则:<dsh:assignmentRule candidateRoleId="..."/>
      // (单人/会签/串签语义由 BPMN 原生 multiInstanceLoopCharacteristics 表达,
      // 不再单独配置处理策略)
      name: 'AssignmentRule',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:UserTask'] },
      properties: [
        { name: 'candidateRoleId', isAttr: true, type: 'String' },
      ],
    },
    // userPrompt 存 text 属性:<dsh:userPrompt text="..."/>。
    // 不用元素正文:引擎 StAX 配置 IS_REPLACING_ENTITY_REFERENCES=false 会把含引号的
    // 正文切成多个 CHARACTER 事件,Flowable 的 setElementText 只保留最后一段,
    // JSON 骨架会被截断;属性值由 getAttributeValue 一次性完整解码,
    // 与 flowable:class 等 Flowable 扩展属性同一存储模式(引擎 DshBpmnExtensionParser 对齐)。
    {
      name: 'UserPrompt',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:UserTask'] },
      properties: [{ name: 'text', isAttr: true, type: 'String' }],
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
    // ----- Process Context 机制(design 2026-09-01) -----
    {
      // 流程级上下文变量声明容器:
      // <dsh:contextVariables><dsh:contextVariable .../>...</dsh:contextVariables>
      name: 'ContextVariables',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:Process'] },
      properties: [
        { name: 'contextVariable', isMany: true, type: 'dsh:ContextVariable' },
      ],
    },
    {
      // 单个上下文变量:name 流程内唯一;type 八种(string/integer/float/boolean/
      // date/datetime/object/array);source="start-param" 标记启动传入;
      // initialValue 初始值(与 start-param 可共存兜底);itemType 为 array 的
      // 元素类型;object/array 元素为 object 时挂 field 字段清单。
      name: 'ContextVariable',
      superClass: ['Element'],
      properties: [
        { name: 'name', isAttr: true, type: 'String' },
        { name: 'type', isAttr: true, type: 'String' },
        { name: 'description', isAttr: true, type: 'String' },
        { name: 'initialValue', isAttr: true, type: 'String' },
        { name: 'itemType', isAttr: true, type: 'String' },
        { name: 'source', isAttr: true, type: 'String' },
        { name: 'field', isMany: true, type: 'dsh:Field' },
      ],
    },
    {
      // object 字段清单条目(支持嵌套:field 类型为 object 时可再挂 field)
      name: 'Field',
      superClass: ['Element'],
      properties: [
        { name: 'name', isAttr: true, type: 'String' },
        { name: 'type', isAttr: true, type: 'String' },
        { name: 'description', isAttr: true, type: 'String' },
        { name: 'field', isMany: true, type: 'dsh:Field' },
      ],
    },
    {
      // userTask 输出映射容器:source=提交 JSON 的顶层字段/点路径(空=整体),
      // target=上下文变量名(可带 .field 深入路径);引擎提交端点执行写入
      name: 'OutputMappings',
      superClass: ['Element'],
      meta: { allowedIn: ['bpmn:UserTask'] },
      properties: [
        { name: 'mapping', isMany: true, type: 'dsh:Mapping' },
      ],
    },
    {
      name: 'Mapping',
      superClass: ['Element'],
      properties: [
        { name: 'source', isAttr: true, type: 'String' },
        { name: 'target', isAttr: true, type: 'String' },
      ],
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
 * SendTask 的画布入口已隐藏(replace-menu-filter),描述符仍保留 SendTask:
 * 粘贴含 flowable: 属性的 sendTask XML 时往返保真,非法组合由引擎发布校验报错。
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
